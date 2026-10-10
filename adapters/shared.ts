/**
 * ohmyjev for pi and omp: the I/O both adapters share. Jev over fetch, ~/.ohmyjev storage (the same files the Claude
 * Code plugin and extras/statusline_segment.py use), path checks, ask_jev and /jev. Plain Node APIs only, so it runs
 * under pi (Node) and omp (Bun). Every decision stays in hooks/policy.ts; every failure passes the call through.
 */
import { execFile } from 'node:child_process'
import { appendFile, chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { ENDPOINTS, JevError, parseReply, pickKey, type Key } from '../hooks/jev.ts'
import {
  EMPTY_SESSION, absolute, buildQuestion, clip, expandRoot, hostPath, isUnder, normalize, parseWorktrees, rawAbsolute, sanitizeSid, splitList, statusText,
  summarize, type Answers, type Config, type LogEntry, type Questions, type SessionState, type Verdict,
} from '../hooks/policy.ts'

export type Env = Readonly<Record<string, string | undefined>>
const DOWN_MS = 5 * 60_000

/** Config apiKey, then $TYPESAFE_API_KEY, then $OPENROUTER_API_KEY; null when none is set. */
export const keyOf = (c: Config, env: Env): Key | null => pickKey(c.apiKey, c.jevModel, env.TYPESAFE_API_KEY, env.OPENROUTER_API_KEY)

/** The one fetch shape ohmyjev uses; tests pass a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** One decision request, cut off at c.timeoutMs. Throws JevError; the caller passes through on any failure. */
export async function askJev(c: Config, env: Env, state: unknown, questions: Questions, fetchImpl: Fetch = fetch) {
  const k = keyOf(c, env)
  if (!k) throw new JevError('no key', true)
  const started = Date.now()
  let res: { ok: boolean; status: number; text: string }
  try {
    const r = await fetchImpl(ENDPOINTS[k.provider], {
      method: 'POST',
      headers: { authorization: `Bearer ${k.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: k.model, state, questions }),
      signal: AbortSignal.timeout(c.timeoutMs),
    })
    res = { ok: r.ok, status: r.status, text: await r.text() }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new JevError(timedOut ? `${k.provider}: no answer within ${c.timeoutMs}ms` : `${k.provider}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const { answers, inputTokens } = parseReply(res, k.provider, questions)
  // the model we asked for, never a string the provider echoed back
  return { answers, meta: { model: k.model, ms: Date.now() - started, inputTokens, costUsd: inputTokens * 0.042e-6 } }
}

/** A decision in flight: its log entry, finished by record(). */
export type Decision = { answers: Answers; e: LogEntry }

/**
 * One agent session's counters and log, under ~/.ohmyjev. Writes are fire-and-forget: the statusline may lag a write,
 * a decision never waits for one. `onChange` sees the counters after every change (the adapter pins the status).
 */
export class Session {
  s: SessionState = { ...EMPTY_SESSION }
  readonly sid: string
  private readonly dir: string
  private ready: Promise<void>

  constructor(
    readonly c: Config,
    readonly env: Env,
    sessionId: string,
    private readonly onChange: (s: SessionState) => void = () => {},
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.sid = sanitizeSid(sessionId)
    this.dir = `${env.HOME ?? ''}/.ohmyjev`
    this.ready = this.load()
  }

  get logPath() {
    return `${this.dir}/log/${this.sid}.jsonl`
  }
  private get statePath() {
    return `${this.dir}/sessions/${this.sid}.json`
  }

  /** Owner-only directories (logs name commands and paths), then the saved counters. Best effort throughout. */
  private async load(): Promise<void> {
    const dirs = [this.dir, `${this.dir}/log`, `${this.dir}/sessions`]
    for (const d of dirs) await mkdir(d, { recursive: true, mode: 0o700 }).then(() => chmod(d, 0o700)).catch(() => undefined)
    const text = await readFile(this.statePath, 'utf8').catch(() => undefined)
    if (text === undefined) return
    try {
      this.s = { ...EMPTY_SESSION, ...(JSON.parse(text) as Partial<SessionState>) }
    } catch {
      // a torn file: fresh counters
    }
  }

  save(): void {
    void this.ready.then(() => writeFile(this.statePath, JSON.stringify(this.s))).catch(() => undefined)
    this.onChange(this.s)
  }

  /** Each line starts with `\n`, so a torn earlier line never swallows this one; readers skip blanks. */
  log(entry: Omit<LogEntry, 'ts' | 'session'>): void {
    const line = '\n' + JSON.stringify({ ts: Date.now(), session: this.sid, ...entry }) + '\n'
    void this.ready.then(() => appendFile(this.logPath, line, { mode: 0o600 })).catch(() => undefined)
  }

  /** Ask Jev. Any failure is logged, shown in the status, and answered with null so the caller passes through. */
  async decide(event: string, tool: string, state: unknown, questions: Questions): Promise<Decision | null> {
    await this.ready
    const e: LogEntry = { ts: Date.now(), session: this.sid, event, tool }
    try {
      const { answers, meta } = await askJev(this.c, this.env, state, questions, this.fetchImpl)
      Object.assign(e, meta, { answers })
      this.s.calls++
      this.s.noKey = false
      this.s.downUntil = 0
      return { answers, e }
    } catch (err) {
      if (err instanceof JevError && err.noKey) {
        if (this.s.noKey) return null // said once
        this.s.noKey = true
      } else if (err instanceof JevError) {
        this.s.downUntil = Date.now() + DOWN_MS
      }
      e.error = err instanceof Error ? err.message : String(err) // a non-Jev error is our bug: logged, not shown as an outage
      this.save()
      this.log(e)
      return null
    }
  }

  record(d: Decision, verdict: Verdict, reason: string): void {
    d.e.verdict = verdict
    d.e.reason = reason
    if (verdict === 'deny' || verdict === 'block') this.s.denies++
    this.save()
    this.log(d.e)
  }

  /** A deny decided by code (a path), counted and logged like Jev's. */
  denyByCode(tool: string, reason: string): void {
    this.s.denies++
    this.save()
    this.log({ event: 'tool_call', tool, verdict: 'deny', reason })
  }

  noteRoute(label: string): void {
    if (this.s.lastRoute === label) return
    this.s.lastRoute = label
    this.save()
  }

  status(now = Date.now()): string {
    return statusText(keyOf(this.c, this.env) ? this.s : { ...this.s, noKey: true }, now)
  }

  /** /jev: this session's status and log summary, and where the key comes from (never the key). */
  async report(): Promise<string> {
    await this.ready
    const log = await readFile(this.logPath, 'utf8').catch(() => '')
    const k = keyOf(this.c, this.env)
    return [
      statusText(this.s, Date.now()),
      summarize(log),
      `key: ${k ? `${k.source} · ${k.provider} · ${k.model}` : 'none (set TYPESAFE_API_KEY or the apiKey setting)'}`,
    ].join('\n')
  }
}

// --- paths: code decides, never Jev ---

/** The repo root: git's top level from cwd, else cwd itself. */
export function repoRoot(cwd: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  execFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 2000 }, (err, stdout) => resolve(err ? cwd : stdout.trim() || cwd))
  return promise
}

/** Every checkout of the repo `cwd` is in; none when cwd is not in a repo or git is unavailable. */
export function worktrees(cwd: string): Promise<string[]> {
  const { promise, resolve } = Promise.withResolvers<string[]>()
  execFile('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { timeout: 2000 }, (err, stdout) => resolve(err ? [] : parseWorktrees(stdout)))
  return promise
}

/**
 * Where an absolute spelling lands by the OS's rules: each existing component's link followed as it is reached, then
 * `..` from where that link led. Null (deny) for a dangling link or a path that exists yet will not resolve.
 */
async function place(p: string): Promise<string | null> {
  let cur = ''
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      cur = cur.slice(0, cur.lastIndexOf('/'))
      continue
    }
    cur = `${cur}/${part}`
    const exists = await lstat(cur).then(() => true, () => false)
    if (!exists) continue
    const real = await realpath(cur).catch(() => null)
    if (real === null) return null
    cur = normalize(real).replace(/^\/$/, '')
  }
  return cur || '/'
}

export { hostPath }

/**
 * Allowed only when the OS's reading (raw spelling) and a normalizing tool's reading (lexical) both land in a root:
 * the session's repo, every worktree of the repo `cwd` is in (a sibling worktree, or another project the agent was
 * told to work in), plus allowPaths for writes. Spelled the way the host's tools read it (hostPath); another machine
 * never is.
 */
export async function pathAllowed(spelled: string, cwd: string, root: string, c: Config, env: Env, withAllowPaths = true): Promise<boolean> {
  const path = hostPath(spelled)
  if (path === null) return false
  const home = env.HOME ?? ''
  const roots: string[] = []
  const extra = withAllowPaths ? splitList(c.allowPaths).map(r => expandRoot(r, home, env.TMPDIR)) : []
  for (const r of [root, ...(await worktrees(cwd)), ...extra]) {
    const placed = r ? await place(r) : null
    if (placed) roots.push(placed)
  }
  const targets = [await place(rawAbsolute(path, cwd, home)), await place(absolute(path, cwd, home))]
  return targets.every(t => t !== null && roots.some(r => isUnder(t, r)))
}

// --- ask_jev: a judgment about repo files or text, without reading them into the model's context ---

export const ASK_DESCRIPTION =
  'Ask Jev, a fast (~300 ms) and nearly free decision model, one question about repo files or text: yes/no (noul), ' +
  'multiple choice (choice), or a position on levels (score). Use it for a judgment ABOUT content without reading it ' +
  'into your context: is this file relevant, does this log show the failure, which of these is riskiest. Read the file ' +
  'yourself when you need to edit or quote it. Values under ~0.7 mean Jev is unsure.'
/** JSON Schema of ask_jev's input; each adapter wraps it in its host's schema type. */
export const ASK_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question, about `files` and/or `state`' },
    type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'noul = probability of yes; choice = one of options; score = a position on options as levels, low to high' },
    options: { type: 'array', items: { type: 'string' }, description: 'choice labels, or 2-10 score levels from low to high' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo file paths whose contents Jev reads (not you)' },
    state: { type: 'string', description: 'Any other text Jev should judge' },
  },
  required: ['question', 'type'],
} as const
const ASK_FILE = 8000
const ASK_TOTAL = 80000

/** ask_jev's answer as JSON text: Jev's answer, or `{error}`. Files outside the repo are never sent. */
export async function answerAsk(x: Session, input: Record<string, unknown>, cwd: string, root: string): Promise<string> {
  const q = buildQuestion(input)
  if (typeof q === 'string') return JSON.stringify({ error: q })
  const home = x.env.HOME ?? ''
  const files: Record<string, string> = {}
  let budget = ASK_TOTAL
  for (const f of (Array.isArray(input.files) ? input.files : []).filter((f): f is string => typeof f === 'string').slice(0, 255)) {
    if (!(await pathAllowed(f, cwd, root, x.c, x.env, false))) files[f] = '[outside the repo: not sent]'
    else if (budget <= 0) files[f] = '[over the size budget: not sent]'
    else {
      const text = await readFile(absolute(hostPath(f) ?? f, cwd, home), 'utf8').catch(() => undefined)
      files[f] = text === undefined ? '[unreadable]' : clip(text, Math.min(ASK_FILE, budget))
    }
    budget = Math.max(0, budget - files[f]!.length)
  }
  const state = { ...(Object.keys(files).length ? { files } : {}), ...(typeof input.state === 'string' ? { text: clip(input.state, 20000) } : {}) }
  const d = await x.decide('ask_jev', 'ask_jev', state, { answer: q })
  if (!d) return JSON.stringify({ error: 'jev unavailable: answer from your own reading' })
  x.record(d, null, 'asked')
  return JSON.stringify(d.answers.answer)
}
