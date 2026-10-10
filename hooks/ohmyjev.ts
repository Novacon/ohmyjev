/**
 * ohmyjev v1: Jev in front of risky tool calls. Decisions live in policy.ts; this file gathers state, asks Jev and
 * answers the engine. Every failure passes through; storage is fire-and-forget.
 */
import type { EngineInterface, Register, SessionMessage, ToolCallResult } from 'claude-code'
import { ENDPOINTS, JevError, parseReply, pickKey, type Key } from './jev.ts'
import {
  BASH_Q, EXFIL_Q, ROUTE_Q, SCREEN_Q, STOP_Q, SWITCHED_Q, WRITE_Q,
  EMPTY_SESSION, absolute, clip, denyText, expandRoot, gateBash, gateExfil, gateWrite, hostPath, isUnder, judgeStop, normalize, parseWorktrees, pathDenyText, rawAbsolute,
  buildQuestion, builtinRoute, decideRoute, jevRouteLine, keepInstructions, statusText, stepLine, summarize, modelOf, readConfig, routeStep,
  sanitizeSid, screen, splitList, withPolicies, withPolicyQ, TIER_LABELS,
  type Config, type LogEntry, type Route, type Questions, type SessionState, type Verdict,
} from './policy.ts'

type $ = EngineInterface
type Paths = { dir: string; log: string; session: string; sid: string }
type Ctx = { p: Paths; s: SessionState }

const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
const HOOKED = ['Bash', 'WebFetch', 'Read', 'Write', 'Edit', 'NotebookEdit', /^mcp__/] as const
const ASK = 'mcp__ohmyjev__ask_jev'
const DOWN_MS = 5 * 60_000
const CLIP = 16000

const arg = (e: unknown, k: string): string => {
  const v = e && typeof e === 'object' ? (e as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' ? v : ''
}

/**
 * pi's own tools bridged in by pi-claude-bridge (`mcp__custom-tools__bash`) run on this machine: they get the native
 * tool's gate, never the exfil gate meant for outside services. pi spells a path `path` and an edit `edits`.
 */
const BRIDGED: Record<string, string> = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit' }
const kindOf = (tool: string): string => BRIDGED[/^mcp__custom-tools__(\w+)$/.exec(tool)?.[1] ?? ''] ?? tool
/** The local path a file call names, as the host's tool opens it; null for another machine (deny). */
const pathOf = (e: unknown): string | null => hostPath(arg(e, 'file_path') || arg(e, 'notebook_path') || arg(e, 'path'))

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

/** Config apiKey, then $TYPESAFE_API_KEY, then $OPENROUTER_API_KEY; null when none is set. */
async function keyOf($: $, c: Config): Promise<Key | null> {
  return pickKey(c.apiKey, c.jevModel, await $.env.get('TYPESAFE_API_KEY'), await $.env.get('OPENROUTER_API_KEY'))
}

/** One decision request, raced against a timeout. Throws JevError; the caller passes through on any failure. */
async function askJev($: $, c: Config, state: unknown, questions: Questions, timeoutMs: number) {
  const k = await keyOf($, c)
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

/** Fire-and-forget: the statusline may lag a write, a decision never waits for one. Also repins the on-screen status. */
function writeSession($: $, p: Paths, s: SessionState): void {
  void $.fs.write(p.session, JSON.stringify(s)).catch(() => undefined)
  showStatus($, s)
}

/** The status line pinned under the prompt, the same text the statusline segment shows. */
function showStatus($: $, s: SessionState): void {
  if (!c.statusLine) return
  try {
    $.ui.status(statusText(s, Date.now()))
  } catch {
    // a surface with no status line: the statusline file still has it
  }
}

/** One dim transcript line, never sent to the model; a `-p` or SDK host gets it as `ui_log`, the debug log either way. */
function say($: $, text: string): void {
  if (!c.logDecisions) return
  try {
    $.ui.log(`[ohmyjev] ${text}`)
  } catch {
    // nowhere to draw it: the decision log has the same facts
  }
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
let liveRequest = '' // the latest request the Stop hook saw: what any compaction must keep
let compactPending = false // a task switch at a boundary, waiting for the context to fill past compactMinPercent
let saidStepFor = '' // the turn whose main-loop routing line is already in the transcript

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
    const { answers, meta } = await askJev($, c, state, questions, c.timeoutMs)
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

/** Every checkout of the repo `cwd` is in; none when cwd is not in a repo or git is unavailable. */
async function worktrees($: $, cwd: string): Promise<string[]> {
  const r = await $.process.run(['git', '-C', cwd, 'worktree', 'list', '--porcelain'], { timeoutMs: 2000 }).catch(() => undefined)
  return r?.exitCode === 0 ? parseWorktrees(r.stdout) : []
}

/**
 * Allowed only when the OS's reading (raw spelling) and a normalizing tool's reading (lexical) both land in a root:
 * the session's repo, every worktree of the repo the agent's cwd is in (so a sibling worktree, or another project it
 * was told to work in, counts), plus allowPaths for writes.
 */
async function pathAllowed($: $, path: string, cwd: string, withAllowPaths = true): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? ''
  const tmpdir = await $.env.get('TMPDIR')
  const roots: string[] = []
  const extra = withAllowPaths ? splitList(c.allowPaths).map(r => expandRoot(r, home, tmpdir)) : []
  for (const r of [await $.session.root(), ...(await worktrees($, cwd)), ...extra]) {
    const placed = r ? await place($, r) : null
    if (placed) roots.push(placed)
  }
  const targets = [await place($, rawAbsolute(path, cwd, home)), await place($, absolute(path, cwd, home))]
  return targets.every(t => t !== null && roots.some(root => isUnder(t, root)))
}

// --- gates (before the tool runs) ---

async function gate($: $, e: { tool: string }): Promise<string | undefined> {
  const tool = String(e.tool)
  const kind = kindOf(tool)
  const cwd = await $.session.cwd()
  if (kind === 'Bash' && c.bashGate) {
    const command = arg(e, 'command')
    const state = { command: clip(command, CLIP), cwd, description: clip(arg(e, 'description'), 300), ...(command.length > CLIP ? { truncated: true } : {}) }
    const d = await decide($, 'tool.call', tool, withPolicies(state, c), withPolicyQ(BASH_Q, c))
    if (!d) return undefined
    const j = gateBash(d.answers, c)
    record($, d, j.verdict, j.reason)
    return j.verdict === 'deny' ? denyText(j.reason) : undefined
  }
  if (WRITE_TOOLS.includes(kind) && c.writeGate) {
    const path = pathOf(e)
    if (path === null || !(await pathAllowed($, path, cwd))) {
      const shown = path ?? arg(e, 'path')
      const x = await session($)
      x.s.denies++
      writeSession($, x.p, x.s)
      appendLog($, x.p, { ts: Date.now(), session: x.p.sid, event: 'tool.call', tool, verdict: 'deny', reason: `${shown} is outside the repo and allowPaths` })
      return pathDenyText(shown)
    }
    const edits = (e as { edits?: unknown }).edits
    const content = arg(e, 'content') || arg(e, 'new_string') || arg(e, 'new_source') || (Array.isArray(edits) ? JSON.stringify(edits) : '')
    const d = await decide($, 'tool.call', tool, withPolicies({ path, content: clip(content, CLIP) }, c), withPolicyQ(WRITE_Q, c))
    if (!d) return undefined
    const j = gateWrite(d.answers, c)
    record($, d, j.verdict, j.reason)
    return j.verdict === 'deny' ? denyText(j.reason) : undefined
  }
  if ((kind === 'WebFetch' || kind.startsWith('mcp__')) && c.exfilGate) {
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

/** A Read is screened only from outside the repo and allowPaths: those (memory, skills under ~/.claude) are the user's own. */
async function readOutsideRepo($: $, e: { tool: string }): Promise<boolean> {
  const path = pathOf(e)
  return c.screenReads && (path === null || !(await pathAllowed($, path, await $.session.cwd())))
}

async function screenResult($: $, e: { tool: string }, r: ToolCallResult): Promise<ToolCallResult> {
  const tool = String(e.tool)
  const kind = kindOf(tool)
  if (!c.injectionScreen || WRITE_TOOLS.includes(kind) || r.deny !== undefined || !r.text?.trim()) return r
  if (kind === 'Read' && !(await readOutsideRepo($, e))) return r
  const d = await decide($, 'tool.result', tool, { tool, content: clip(r.text, 6000) }, SCREEN_Q)
  if (!d) return r
  const s = screen(d.answers, c)
  record($, d, s.flagged ? 'flag' : null, s.reason)
  return s.flagged ? { ...r, context: [...(r.context ?? []), s.note] } : r
}

// --- ask_jev: a judgment about repo files or text, without reading them into the model's context ---

const ASK_DESCRIPTION =
  'Ask Jev, a fast (~300 ms) and nearly free decision model, one question about repo files or text: yes/no (noul), ' +
  'multiple choice (choice), or a position on levels (score). Use it for a judgment ABOUT content without reading it ' +
  'into your context: is this file relevant, does this log show the failure, which of these is riskiest. Read the file ' +
  'yourself when you need to edit or quote it. Values under ~0.7 mean Jev is unsure.'
const ASK_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question, about `files` and/or `state`' },
    type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'noul = probability of yes; choice = one of options; score = a position on options as levels, low to high' },
    options: { type: 'array', items: { type: 'string' }, description: 'choice labels, or 2-10 score levels from low to high' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo file paths whose contents Jev reads (not you)' },
    state: { type: 'string', description: 'Any other text Jev should judge' },
  },
  required: ['question', 'type'],
}
const ASK_FILE = 8000
const ASK_TOTAL = 80000

async function answerAsk($: $, e: Record<string, unknown>): Promise<ToolCallResult> {
  const reply = (v: unknown): ToolCallResult => ({ result: JSON.stringify(v) })
  const q = buildQuestion(e)
  if (typeof q === 'string') return reply({ error: q })
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const files: Record<string, string> = {}
  let budget = ASK_TOTAL
  for (const f of (Array.isArray(e.files) ? e.files : []).filter((f): f is string => typeof f === 'string').slice(0, 255)) {
    if (!(await pathAllowed($, f, cwd, false))) files[f] = '[outside the repo: not sent]'
    else if (budget <= 0) files[f] = '[over the size budget: not sent]'
    else {
      const text = await $.fs.read(absolute(f, cwd, home)).catch(() => undefined)
      files[f] = typeof text === 'string' ? clip(text, Math.min(ASK_FILE, budget)) : '[unreadable]'
    }
    budget = Math.max(0, budget - files[f]!.length)
  }
  const state = { ...(Object.keys(files).length ? { files } : {}), ...(typeof e.state === 'string' ? { text: clip(e.state, 20000) } : {}) }
  const d = await decide($, 'ask_jev', ASK, state, { answer: q })
  if (!d) return reply({ error: 'jev unavailable: answer from your own reading' })
  record($, d, null, 'asked')
  return reply(d.answers.answer)
}

/** /jev: this session's status and log summary, and where the key comes from (never the key). */
async function jevReport($: $): Promise<string> {
  const x = await session($)
  const log = await $.fs.read(x.p.log).catch(() => '')
  const k = await keyOf($, c)
  return [
    statusText(x.s, Date.now()),
    summarize(typeof log === 'string' ? log : ''),
    `key: ${k ? `${k.source} · ${k.provider} · ${k.model}` : 'none (set TYPESAFE_API_KEY or the apiKey setting)'}`,
  ].join('\n')
}

/** /jev settings: every setting's current value, the key only as set or not. */
function settingsReport(): string {
  const rows = Object.entries(c).map(([k, v]) =>
    k === 'apiKey' ? `apiKey: ${v ? 'set (hidden)' : 'not set'}` : `${k}: ${v === '' ? '(empty)' : String(v)}`)
  return [...rows, '', 'Edit with /plugin configure ohmyjev@ohmyjev, then /reload-plugins.'].join('\n')
}

// --- router: classify once per turn, then steer effort (main loop) and the subagent model ---

async function classify($: $, text: string): Promise<void> {
  if (!text.trim()) return // a continuation: keep this task's route
  route = undefined
  if (!(c.routeEffort || c.routeSubagents || c.routeMainModel) || /^\/\S+\s*$/.test(text.trim())) return
  if (!(await keyOf($, c))) return classifyBuiltin($, text)
  const d = await decide($, 'turn.start', '', { request: clip(text, 1500) }, ROUTE_Q)
  if (!d) return
  route = decideRoute(d.answers, c)
  say($, jevRouteLine(d.answers, d.e.ms))
  record($, d, null, `${route.tier} (${route.tierConf?.toFixed(2) ?? 'n/d'}), ${route.effort} (${route.effortConf?.toFixed(2) ?? 'n/d'})`)
}

/** No Jev key: Claude Code's own small model picks the tier. It reports no confidence, so the route only moves up. */
async function classifyBuiltin($: $, text: string): Promise<void> {
  if (!c.routeWithoutKey) return
  route = builtinRoute(await $.model.classify(clip(text, 1500), TIER_LABELS).catch(() => undefined))
  if (!route) return
  say($, `built-in classifier (no Jev key): tier ${route.tier}, effort ${route.effort}; no confidence, so it only routes up`)
  const x = await session($)
  appendLog($, x.p, { ts: Date.now(), session: x.p.sid, event: 'turn.start', tool: '', verdict: null, reason: `builtin: ${route.tier}, ${route.effort}` })
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
  liveRequest = ''
  compactPending = false
  saidStepFor = ''

  on('turn.start', async ($, e, next) => {
    await classify($, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (!route || e.agentId) return yield* next(e)
    const { patch, label } = routeStep(route, e, c)
    if (saidStepFor !== e.turnId) {
      saidStepFor = e.turnId
      const line = stepLine(route, e, label, c)
      if (line) say($, line)
    }
    await noteRoute($, label)
    return yield* next({ ...e, ...patch })
  })

  on('agent.spawn', ($, e, next) => {
    if (!route || !c.routeSubagents || e.model || e.fork || e.subagentType !== 'general-purpose') return next(e)
    const model = modelOf(route.tier, c)
    say($, `subagent → ${model} (${route.tier})`)
    return next({ ...e, model })
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    if (c.askJev) await $.tool.register({ name: 'ask_jev', description: ASK_DESCRIPTION, inputSchema: ASK_SCHEMA }).catch(() => undefined)
    await $.command.register({ name: 'jev', description: "ohmyjev: this session's Jev calls, denies, cost and key source", argumentHint: '[settings]' }).catch(() => undefined)
    const k = await keyOf($, c)
    say(
      $,
      k
        ? `ready: Jev via ${k.provider} (${k.model}, key from ${k.source})`
        : `no Jev key: gates and screens let every call through${c.routeWithoutKey ? '; routing uses the built-in classifier, up only' : ''}. Set TYPESAFE_API_KEY or the apiKey setting.`,
    )
    const x = await session($)
    showStatus($, k ? x.s : { ...x.s, noKey: true })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'jev' }, async ($, e) =>
    ({ text: e.args.trim() === 'settings' ? settingsReport() : await jevReport($) })).catch(($, e, next) => next(e))

  on('tool.call', { tool: HOOKED }, async ($, e, next) => {
    if (e.tool === ASK) return answerAsk($, e as Record<string, unknown>)
    const denied = await gate($, e)
    if (denied) return { deny: denied }
    return screenResult($, e, await next(e))
  }).catch(($, e, next) => next(e)) // a bug of ours passes through

  // --- done-check: once per request; the user's own Stop hooks run first ---

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (e.stop_hook_active || !(c.doneCheck || c.autoCompact)) return r
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
    liveRequest = state.current_request
    const questions = state.previous_requests.length ? { ...STOP_Q, ...SWITCHED_Q } : STOP_Q
    const d = await decide($, 'Stop', '', state, questions)
    if (!d) return r
    const j = judgeStop(d.answers, c)
    const block = c.doneCheck ? j.block : null
    if (block) pushedBackAt = requests.length
    if (c.autoCompact && j.wantsCompact) compactPending = true
    record($, d, block ? 'block' : null, block ?? (j.wantsCompact ? 'task switched' : 'stop ok'))
    return block ? { ...r, block } : r
  })

  // --- auto-compact: after a turn, once the task switched and the context is full enough ---

  on('session.measure', async ($, e, next) => {
    if (c.autoCompact && compactPending && (e.context.percent ?? 0) >= c.compactMinPercent) {
      compactPending = false
      const x = await session($)
      x.s.compactions++
      writeSession($, x.p, x.s)
      appendLog($, x.p, { ts: Date.now(), session: x.p.sid, event: 'session.measure', tool: '', verdict: 'compact', reason: `${e.context.percent}% after a task switch` })
      void $.session.compact({ instructions: keepInstructions(liveRequest) }).catch(() => undefined) // never awaited inside the hook
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  /** The engine's own threshold compaction keeps the live request too. */
  on('session.compact', ($, e, next) => {
    if (e.trigger !== 'auto' || !liveRequest) return next(e)
    return next({ ...e, instructions: [e.instructions, keepInstructions(liveRequest)].filter(Boolean).join('\n\n') })
  })

  on('session.end', ($, e, next) => {
    ctx = undefined
    pushedBackAt = -1
    route = undefined
    liveRequest = ''
    compactPending = false
    saidStepFor = ''
    return next(e)
  })
}
