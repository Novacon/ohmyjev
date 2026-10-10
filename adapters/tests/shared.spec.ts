import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { BASH_Q, readConfig } from '../../hooks/policy.ts'
import { Session, answerAsk, pathAllowed, type Fetch } from '../shared.ts'

let base = ''
let home = ''
let repo = ''
let outside = ''

beforeAll(async () => {
  base = await realpath(await mkdtemp(`${tmpdir()}/ohmyjev-shared-`))
  home = `${base}/home`
  repo = `${base}/repo`
  outside = `${base}/outside`
  for (const d of [home, `${repo}/src`, outside]) await mkdir(d, { recursive: true })
  await writeFile(`${repo}/src/a.ts`, 'export const a = 1\n')
  await writeFile(`${outside}/secret.txt`, 'TOKEN=abc\n')
  await symlink(outside, `${repo}/link`)
  await symlink(`${base}/nowhere`, `${repo}/dangling`)
})
afterAll(() => rm(base, { recursive: true, force: true }))

const c = readConfig({ allowPaths: '' })
const env = () => ({ HOME: home, TYPESAFE_API_KEY: 'ts-test' })
const reply = (answers: unknown) => new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }))
const bash = { effect: { type: 'choice', choice: 'read_only', confidence: 0.9 }, destructive_intent: { type: 'noul', noul: 0 } }

test('a write through a link out of the repo, or a dangling link, is not allowed; a repo file is', async () => {
  expect(await pathAllowed('src/a.ts', repo, repo, c, env())).toBe(true)
  expect(await pathAllowed('link/secret.txt', repo, repo, c, env())).toBe(false)
  expect(await pathAllowed('link/../src/a.ts', repo, repo, c, env())).toBe(false) // the OS follows the link before `..`
  expect(await pathAllowed('dangling/x', repo, repo, c, env())).toBe(false)
  expect(await pathAllowed(`${outside}/secret.txt`, repo, repo, readConfig({ allowPaths: outside }), env())).toBe(true)
})

test('every worktree of the repo the cwd is in counts as the repo; a non-repo cwd keeps only the session root', async () => {
  const main = `${base}/wt-main`
  const side = `${base}/wt-side`
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  await mkdir(main, { recursive: true })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git('worktree', 'add', '-q', side)
  expect(await pathAllowed(`${main}/a.txt`, side, side, c, env())).toBe(true) // session in side, writing to main
  expect(await pathAllowed(`${side}/a.txt`, main, main, c, env())).toBe(true) // and the other way
  expect(await pathAllowed(`${side}/a.txt`, side, repo, c, env())).toBe(true) // session in repo, agent moved into side
  expect(await pathAllowed(`${outside}/a.txt`, outside, repo, c, env())).toBe(false) // outside is not a repo
  expect(await pathAllowed(`${repo}/src/a.ts`, outside, repo, c, env())).toBe(true) // the session root still counts
})

test('host path spellings are checked where the tool would write: @, :, file:// and other machines', async () => {
  expect(await pathAllowed('@~/.bashrc', repo, repo, c, env())).toBe(false)
  expect(await pathAllowed(`:${outside}/secret.txt`, repo, repo, c, env())).toBe(false)
  expect(await pathAllowed(`file://${outside}/secret.txt`, repo, repo, c, env())).toBe(false)
  expect(await pathAllowed('ssh://prod/etc/cron.d/job', repo, repo, c, env())).toBe(false)
  expect(await pathAllowed(`@${repo}/src/a.ts`, repo, repo, c, env())).toBe(true)
  expect(await pathAllowed(`file://${repo}/src/a.ts`, repo, repo, c, env())).toBe(true)
})

test('a Jev that never answers passes through after timeoutMs and marks Jev down', async () => {
  const hang: Fetch = (_url, init) =>
    new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
  const x = new Session(readConfig({ timeoutMs: 50 }), env(), 'hang', undefined, hang)
  const started = Date.now()
  expect(await x.decide('tool_call', 'bash', { command: 'ls' }, BASH_Q)).toBe(null)
  expect(Date.now() - started).toBeLessThan(1000)
  expect(x.s.downUntil).toBeGreaterThan(Date.now())
})

test('no key: nothing is sent, the status says so, and the error is logged once', async () => {
  let sent = 0
  const x = new Session(c, { HOME: home }, 'nokey', undefined, async () => (sent++, reply(bash)))
  expect(await x.decide('tool_call', 'bash', {}, BASH_Q)).toBe(null)
  expect(await x.decide('tool_call', 'bash', {}, BASH_Q)).toBe(null)
  expect(sent).toBe(0)
  expect(x.status()).toBe('jev ⚠ no key')
  await Bun.sleep(50)
  const lines = (await readFile(x.logPath, 'utf8')).split('\n').filter(Boolean)
  expect(lines.length).toBe(1)
})

test('a deny is counted, persisted for the statusline and reported by /jev', async () => {
  const x = new Session(c, env(), 'deny', undefined, async () => reply(bash))
  const d = await x.decide('tool_call', 'bash', { command: 'rm -rf /' }, BASH_Q)
  expect(d).not.toBe(null)
  x.record(d!, 'deny', 'irreversible (0.95)')
  await Bun.sleep(50)
  expect(JSON.parse(await readFile(`${home}/.ohmyjev/sessions/deny.json`, 'utf8'))).toMatchObject({ calls: 1, denies: 1 })
  expect(await x.report()).toContain('irreversible (0.95)')
})

test('ask_jev sends repo files, never a file outside the repo', async () => {
  const bodies: Array<{ state: { files?: Record<string, string> } }> = []
  const x = new Session(c, env(), 'ask', undefined, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return reply({ answer: { type: 'noul', noul: 0.8 } })
  })
  const out = await answerAsk(x, { question: 'Is a exported?', type: 'noul', files: ['src/a.ts', `${outside}/secret.txt`, 'link/secret.txt'] }, repo, repo)
  expect(JSON.parse(out)).toMatchObject({ type: 'noul', noul: 0.8 })
  const files = bodies[0]!.state.files!
  expect(files['src/a.ts']).toContain('export const a')
  expect(files[`${outside}/secret.txt`]).not.toContain('TOKEN')
  expect(files['link/secret.txt']).not.toContain('TOKEN')
})
