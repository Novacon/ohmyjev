import type { On, SessionMessage } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Answers } from '../hooks/policy.ts'

export type Fake = {
  requests: Array<{ url: string; body: { model: string; state: Record<string, unknown>; questions: Record<string, unknown> } }>
  logs: Array<Record<string, unknown>>
  files: Record<string, string>
  ran: string[][]
  stops: number
}

const DIRS = new Set(['/', '/repo', '/repo/src', '/home', '/home/u', '/home/u/.claude', '/home/u/.ohmyjev',
  '/home/u/.ohmyjev/log', '/home/u/.ohmyjev/sessions', '/tmp', '/etc', '/outside', '/outside/subdir'])
const LINKS: Record<string, string> = { '/repo/link': '/outside/subdir' }
const DANGLING = '/repo/dangling' // a link that leads nowhere: stat resolves, realPath absent
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** The OS's reading of a spelling: each link as it is reached, then `..` from where that link led. */
const resolveFake = (path: string): string => {
  let cur = ''
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      cur = cur.slice(0, cur.lastIndexOf('/'))
      continue
    }
    cur = `${cur}/${part}`
    cur = LINKS[cur] ?? cur
  }
  return cur || '/'
}

/** Lets fire-and-forget work settle: the harness answers everything from memory. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** Stands in for the engine beneath the plugin: env, session, fs, process, and Jev over http. */
export function harness(
  on: On,
  answer: (questions: Record<string, unknown>) => Answers | 'hang',
  opts: { status?: number; messages?: SessionMessage[] | 'throw'; env?: Record<string, string>; writeHangs?: boolean } = {},
): Fake {
  const fake: Fake = { requests: [], logs: [], files: {}, ran: [], stops: 0 }
  mock.env(on, opts.env ?? { HOME: '/home/u', TMPDIR: '/tmp', TYPESAFE_API_KEY: 'ts-test' })
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('classic.Stop', () => {
    fake.stops++ // the user's own Stop hooks, beneath the plugin
    return {}
  })
  on('session.messages', () => {
    if (opts.messages === 'throw') throw new Error('messages unavailable')
    return { value: opts.messages ?? [] }
  })
  on('fs.stat', ($, e) => {
    if (e.path === DANGLING) return { value: { kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true } }
    const r = resolveFake(e.path)
    if (DIRS.has(r)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: r !== e.path, realPath: r } }
    if (r in fake.files) return { value: { kind: 'file' as const, size: fake.files[r]!.length, mtimeMs: 0, isLink: false, realPath: r } }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.exists', ($, e) => ({ value: e.path === DANGLING || DIRS.has(resolveFake(e.path)) || resolveFake(e.path) in fake.files }))
  on('fs.read', ($, e) => {
    if (e.path in fake.files) return { value: fake.files[e.path]! }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', async ($, e) => {
    if (opts.writeHangs) await new Promise(() => {})
    fake.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    fake.ran.push([...e.argv])
    if (e.argv[0] === 'sh' && e.argv[2] === 'cat >> "$0"') fake.logs.push(JSON.parse((e.init?.stdin ?? '').trim()))
    return { value: ok() }
  })
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}')
    fake.requests.push({ url: e.url, body })
    const raw = answer(body.questions)
    if (raw === 'hang') return new Promise(() => {})
    // gate tests rarely care about the exfil gate or the screen around the tool: answer them "clean" unless the test did
    const a: Record<string, unknown> = { ...raw }
    for (const k of ['injection', 'exfiltrates']) if (k in body.questions && !(k in a)) a[k] = { type: 'noul', noul: 0 }
    const status = opts.status ?? 200
    return { value: { status, ok: status < 400, headers: {}, text: JSON.stringify({ model: 'jev-1.13.0', answers: a, usage: { input_tokens: 100 } }) } }
  })
  return fake
}

export const bashAns = (effect: string, confidence: number, destructive: number): Answers => ({
  effect: { type: 'choice', choice: effect, confidence },
  destructive_intent: { type: 'noul', noul: destructive },
})
export const writeAns = (kind: string, confidence: number, secret: number): Answers => ({
  kind: { type: 'choice', choice: kind, confidence },
  contains_secret: { type: 'noul', noul: secret },
})
export const nouls = (v: Record<string, number>): Answers =>
  Object.fromEntries(Object.entries(v).map(([k, noul]) => [k, { type: 'noul' as const, noul }]))

