/**
 * ohmyjev v1: Jev in front of risky tool calls. Decisions live in policy.ts; this file gathers state, asks Jev and
 * answers the engine. Every failure passes through; storage is fire-and-forget.
 */
import type { EngineInterface, Register, SessionMessage, ToolCallResult } from 'claude-code'
import { ENDPOINTS, JevError, parseReply, pickKey } from './jev.ts'
import {
  BASH_Q, EXFIL_Q, ROUTE_Q, SCREEN_Q, STOP_Q, WRITE_Q,
  EMPTY_SESSION, absolute, clip, denyText, expandRoot, gateBash, gateExfil, gateWrite, isUnder, judgeStop, normalize, rawAbsolute,
  decideRoute, modelOf, readConfig, routeStep, sanitizeSid, screen, splitList, withPolicies, withPolicyQ,
  type Config, type LogEntry, type Route, type Questions, type SessionState, type Verdict,
} from './policy.ts'

type $ = EngineInterface
type Paths = { dir: string; log: string; session: string; sid: string }
type Ctx = { p: Paths; s: SessionState }

const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
const HOOKED = ['Bash', 'WebFetch', 'Read', 'Write', 'Edit', 'NotebookEdit', /^mcp__/] as const
const DOWN_MS = 5 * 60_000
const CLIP = 16000

const arg = (e: unknown, k: string): string => {
  const v = e && typeof e === 'object' ? (e as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' ? v : ''
}

/** What the transcript shows a call came to: only `ok` counts as evidence of a check. */
const outcomeOf = (t: { tool: string; result?: unknown; text?: string; isError?: true }) => {
  if (t.isError) return 'failed'
  if (t.text === undefined) return 'pending'
  const r = t.result as { backgroundTaskId?: string; interrupted?: boolean; timedOutAfterMs?: number } | undefined
  if (t.tool === 'Bash' && r && (r.backgroundTaskId !== undefined || r.interrupted === true || r.timedOutAfterMs !== undefined))
    return 'backgrounded'
  return 'ok'
}

// --- Jev and storage I/O. Kept in this file: the engine follows `$` only into functions declared here. ---

const TIMEOUT = Symbol('timeout')

/** One decision request, raced against a timeout. Throws JevError; the caller passes through on any failure. */
async function askJev($: $, c: Config, state: unknown, questions: Questions, timeoutMs: number) {
  const k = pickKey(c.apiKey, c.jevModel, await $.env.get('TYPESAFE_API_KEY'), await $.env.get('OPENROUTER_API_KEY'))
  if (!k) throw new JevError('no key', true)
  const started = Date.now()
  const request = $.http.fetch(ENDPOINTS[k.provider], {
    method: 'POST',
    headers: { authorization: `Bearer ${k.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: k.model, state, questions }),
  })
  request.catch(() => {}) // an abandoned request must not surface as unhandled
  const stop = new AbortController()
  const timer = $.clock.sleep(timeoutMs, { signal: stop.signal }).then((): typeof TIMEOUT => TIMEOUT, () => new Promise<never>(() => {})) // aborted is not a timeout
  let res: Awaited<typeof request> | typeof TIMEOUT
  try {
    res = await Promise.race([request, timer])
  } catch (err) {
    throw new JevError(`${k.provider}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    stop.abort()
  }
  if (res === TIMEOUT) throw new JevError(`${k.provider}: no answer within ${timeoutMs}ms`)
  const { answers, inputTokens } = parseReply(res, k.provider, questions)
  // the model we asked for, never a string the provider echoed back
  return { answers, meta: { model: k.model, ms: Date.now() - started, inputTokens, costUsd: inputTokens * 0.042e-6 } }
}

/** ~/.ohmyjev: one JSON file per session for the statusline, one log line per decision. */
async function paths($: $): Promise<Paths> {
  const dir = `${(await $.env.get('HOME')) ?? ''}/.ohmyjev`
  const sid = sanitizeSid(await $.session.id())
  return { dir, log: `${dir}/log/${sid}.jsonl`, session: `${dir}/sessions/${sid}.json`, sid }
}

/** Owner-only directories: logs name commands and paths. Best effort; a failure only means no log. */
async function ensureDirs($: $, p: Paths): Promise<void> {
  const dirs = [p.dir, `${p.dir}/log`, `${p.dir}/sessions`]
  await $.process.run(['mkdir', '-p', '-m', '700', ...dirs], { timeoutMs: 2000 }).catch(() => undefined)
  await $.process.run(['chmod', '700', ...dirs], { timeoutMs: 2000 }).catch(() => undefined)
}

/** The saved counters, or fresh ones when the file is missing, unreadable, or slower than 2 s. */
async function loadSession($: $, p: Paths): Promise<SessionState> {
  const stop = new AbortController()
  const late = $.clock.sleep(2000, { signal: stop.signal }).then(() => undefined, () => new Promise<never>(() => {}))
  try {
    const text = await Promise.race([$.fs.read(p.session), late]).finally(() => stop.abort())
    return typeof text === 'string' ? { ...EMPTY_SESSION, ...(JSON.parse(text) as Partial<SessionState>) } : { ...EMPTY_SESSION }
  } catch {
    return { ...EMPTY_SESSION }
  }
}

/** Fire-and-forget: the statusline may lag a write, a decision never waits for one. */
function writeSession($: $, p: Paths, s: SessionState): void {
  void $.fs.write(p.session, JSON.stringify(s)).catch(() => undefined)
}

/** Fire-and-forget append. Each line starts with `\n`, so a torn earlier line never swallows this one; readers skip blanks. */
function appendLog($: $, p: Paths, entry: LogEntry): void {
  void $.process.run(['sh', '-c', 'cat >> "$0"', p.log], { stdin: '\n' + JSON.stringify(entry) + '\n', timeoutMs: 2000 }).catch(() => undefined)
}

// Per load: register() resets them; the engine follows `$` only into top-level functions of this file.
let c: Config = readConfig({})
let ctx: Ctx | undefined
let pushedBackAt = -1 // request count when the done-check last pushed back: once per request
let route: Route | undefined // this turn's classification; undefined routes nothing

async function session($: $): Promise<Ctx> {
  if (!ctx) {
    const p = await paths($)
    await ensureDirs($, p)
    ctx = { p, s: await loadSession($, p) }
  }
  return ctx
}

/** Ask Jev. Any failure is logged, shown in the status, and answered with null so the caller passes through. */
async function decide($: $, event: string, tool: string, state: unknown, questions: Questions) {
  const x = await session($)
  const e: LogEntry = { ts: Date.now(), session: x.p.sid, event, tool }
  try {
    const { answers, meta } = await askJev($, c, state, questions, 1500)
    Object.assign(e, meta, { answers })
    x.s.calls++
    x.s.noKey = false
    x.s.downUntil = 0
    return { answers, e, x }
  } catch (err) {
    if (err instanceof JevError && err.noKey) {
      if (x.s.noKey) return null // said once
      x.s.noKey = true
    } else if (err instanceof JevError) {
      x.s.downUntil = Date.now() + DOWN_MS
    }
    e.error = err instanceof Error ? err.message : String(err) // a non-Jev error is our bug: logged, not shown as an outage
    writeSession($, x.p, x.s)
    appendLog($, x.p, e)
    return null
  }
}

function record($: $, d: { e: LogEntry; x: Ctx }, verdict: Verdict, reason: string) {
  d.e.verdict = verdict
  d.e.reason = reason
  if (verdict === 'deny' || verdict === 'block') d.x.s.denies++
  writeSession($, d.x.p, d.x.s)
  appendLog($, d.x.p, d.e)
}

// --- paths: code decides, never Jev ---

/**
 * Where an absolute spelling lands by the OS's rules: each existing component's link followed as it is reached, then
 * `..` from where that link led. Only `..`-free prefixes are statted, since `$.fs` folds `..` by spelling before the
 * file system sees it. Null (deny) for a dangling link, a withheld realPath, or a path that exists yet will not stat.
 */
async function place($: $, p: string): Promise<string | null> {
  let cur = ''
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      cur = cur.slice(0, cur.lastIndexOf('/'))
      continue
    }
    cur = `${cur}/${part}`
    const st = await $.fs.stat(cur, { resolve: true }).catch(() => undefined)
    if (st) {
      if (!st.realPath) return null
      cur = normalize(st.realPath).replace(/^\/$/, '')
    } else if (await $.fs.exists(cur).catch(() => true)) return null
  }
  return cur || '/'
}

/** Allowed only when the OS's reading (raw spelling) and a normalizing tool's reading (lexical) both land in a root. */
async function pathAllowed($: $, path: string, cwd: string): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? ''
  const tmpdir = await $.env.get('TMPDIR')
  const roots: string[] = []
  for (const r of [await $.session.root(), ...splitList(c.allowPaths).map(r => expandRoot(r, home, tmpdir))]) {
    const placed = r ? await place($, r) : null
    if (placed) roots.push(placed)
  }
  const targets = [await place($, rawAbsolute(path, cwd, home)), await place($, absolute(path, cwd, home))]
  return targets.every(t => t !== null && roots.some(root => isUnder(t, root)))
}

// --- gates (before the tool runs) ---

async function gate($: $, e: { tool: string }): Promise<string | undefined> {
  const tool = String(e.tool)
  const cwd = await $.session.cwd()
  if (tool === 'Bash' && c.bashGate) {
    const command = arg(e, 'command')
    const state = { command: clip(command, CLIP), cwd, description: clip(arg(e, 'description'), 300), ...(command.length > CLIP ? { truncated: true } : {}) }
    const d = await decide($, 'tool.call', tool, withPolicies(state, c), withPolicyQ(BASH_Q, c))
    if (!d) return undefined
    const j = gateBash(d.answers, c)
    record($, d, j.verdict, j.reason)
    return j.verdict === 'deny' ? denyText(j.reason) : undefined
  }
  if (WRITE_TOOLS.includes(tool) && c.writeGate) {
    const path = arg(e, 'file_path') || arg(e, 'notebook_path')
    if (!(await pathAllowed($, path, cwd))) {
      const reason = `${path} is outside the repo and allowPaths`
      const x = await session($)
      x.s.denies++
      writeSession($, x.p, x.s)
      appendLog($, x.p, { ts: Date.now(), session: x.p.sid, event: 'tool.call', tool, verdict: 'deny', reason })
      return denyText(reason)
    }
    const content = arg(e, 'content') || arg(e, 'new_string') || arg(e, 'new_source')
    const d = await decide($, 'tool.call', tool, withPolicies({ path, content: clip(content, CLIP) }, c), withPolicyQ(WRITE_Q, c))
    if (!d) return undefined
    const j = gateWrite(d.answers, c)
    record($, d, j.verdict, j.reason)
    return j.verdict === 'deny' ? denyText(j.reason) : undefined
  }
  if ((tool === 'WebFetch' || tool.startsWith('mcp__')) && c.exfilGate) {
    const { tool: _t, tool_use_id: _id, consent: _c, ...input } = e as Record<string, unknown>
    const state = withPolicies({ tool, input: clip(JSON.stringify(input), 4000) }, c)
    const d = await decide($, 'tool.call', tool, state, withPolicyQ(EXFIL_Q, c))
    if (!d) return undefined
    const j = gateExfil(d.answers, c)
    record($, d, j.verdict, j.reason)
    return j.verdict === 'deny' ? denyText(j.reason) : undefined
  }
  return undefined
}

// --- injection screen (after the tool ran): Bash, WebFetch, MCP, and Reads from outside the repo ---

/** A Read is screened only from outside the repo: what lives in the repo is the user's own. */
async function readOutsideRepo($: $, e: { tool: string }): Promise<boolean> {
  if (!c.screenReads) return false
  const home = (await $.env.get('HOME')) ?? ''
  return !isUnder(absolute(arg(e, 'file_path'), await $.session.cwd(), home), normalize(await $.session.root()))
}

async function screenResult($: $, e: { tool: string }, r: ToolCallResult): Promise<ToolCallResult> {
  const tool = String(e.tool)
  if (!c.injectionScreen || WRITE_TOOLS.includes(tool) || r.deny !== undefined || !r.text?.trim()) return r
  if (tool === 'Read' && !(await readOutsideRepo($, e))) return r
  const d = await decide($, 'tool.result', tool, { tool, content: clip(r.text, 6000) }, SCREEN_Q)
  if (!d) return r
  const s = screen(d.answers, c)
  record($, d, s.flagged ? 'flag' : null, s.reason)
  return s.flagged ? { ...r, context: [...(r.context ?? []), s.note] } : r
}

// --- router: classify once per turn, then steer effort (main loop) and the subagent model ---

async function classify($: $, text: string): Promise<void> {
  route = undefined
  if (!(c.routeEffort || c.routeSubagents || c.routeMainModel) || /^\/\S+\s*$/.test(text.trim())) return
  const d = await decide($, 'turn.start', '', { request: clip(text, 1500) }, ROUTE_Q)
  if (!d) return
  route = decideRoute(d.answers, c)
  record($, d, null, `${route.tier} (${route.tierConf.toFixed(2)}), ${route.effort} (${route.effortConf.toFixed(2)})`)
}

async function noteRoute($: $, label: string): Promise<void> {
  const x = await session($)
  if (x.s.lastRoute === label) return
  x.s.lastRoute = label
  writeSession($, x.p, x.s)
}

export const register: Register = (on, options) => {
  c = readConfig(options)
  ctx = undefined
  pushedBackAt = -1
  route = undefined

  on('turn.start', async ($, e, next) => {
    await classify($, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (!route || e.agentId) return yield* next(e)
    const { patch, label } = routeStep(route, e, c)
    await noteRoute($, label)
    return yield* next({ ...e, ...patch })
  })

  on('agent.spawn', ($, e, next) => {
    if (!route || !c.routeSubagents || e.model || e.subagentType === 'fork') return next(e)
    return next({ ...e, model: modelOf(route.tier, c) })
  })

  on('tool.call', { tool: HOOKED }, async ($, e, next) => {
    const denied = await gate($, e)
    if (denied) return { deny: denied }
    return screenResult($, e, await next(e))
  }).catch(($, e, next) => next(e)) // a bug of ours passes through

  // --- done-check: once per request; the user's own Stop hooks run first ---

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (e.stop_hook_active || !c.doneCheck) return r
    const msgs: SessionMessage[] = await $.session.messages()
    const isRequest = (m: SessionMessage) => m.role === 'user' && m.text.trim() !== ''
    const requests = msgs.filter(isRequest)
    if (requests.length === pushedBackAt) return r // already pushed back once on this request
    const last = msgs.map(isRequest).lastIndexOf(true)
    const state = {
      current_request: clip(requests.at(-1)?.text, 600),
      previous_requests: requests.slice(-6, -1).map(m => clip(m.text, 200)),
      tools_this_turn: msgs
        .slice(last + 1)
        .flatMap(m => m.toolUses.map(t => ({ tool: t.tool, input: clip(JSON.stringify(t.input), 200), outcome: outcomeOf(t) })))
        .slice(-20),
      last_assistant_message: clip(e.last_assistant_message ?? msgs.filter(m => m.role === 'assistant').at(-1)?.text, 1500),
    }
    const d = await decide($, 'Stop', '', state, STOP_Q)
    if (!d) return r
    const block = judgeStop(d.answers, c)
    if (block) pushedBackAt = requests.length
    record($, d, block ? 'block' : null, block ?? 'stop ok')
    return block ? { ...r, block } : r
  })

  on('session.end', ($, e, next) => {
    ctx = undefined
    pushedBackAt = -1
    route = undefined
    return next(e)
  })
}
