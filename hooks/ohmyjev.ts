/**
 * ohmyjev v1: Jev in front of risky tool calls. Decisions live in policy.ts; this file gathers state, asks Jev and
 * answers the engine. Every failure passes through; storage is fire-and-forget.
 */
import type { EngineInterface, Register, SessionMessage, ToolCallResult } from 'claude-code'
import { FIND_DESCRIPTION, FIND_SCHEMA, find, narrowNote, narrowRead, sweep, type CodeIO } from './code.ts'
import { HEADER as COMPACT_HEADER, judgeable, select, type Block } from './compact.ts'
import { MIN_REPLY, broken, extractionPrompt, filesHash, parseRules, rewriteReason, ruleQuestions, type Rule } from './prose.ts'
import { dashboardHtml } from './dashboard.ts'
import { ENDPOINTS, JevError, parseReply, pickKey, type Key } from './jev.ts'
import {
  BASH_Q, EXFIL_Q, ROUTE_Q, SCREEN_Q, STOP_Q, SWITCHED_Q, WRITE_Q,
  EMPTY_SESSION, absolute, clip, denyText, expandRoot, gateBash, gateExfil, gateWrite, hostPath, isUnder, judgeStop, normalize, parseWorktrees, pathDenyText, rawAbsolute,
  buildQuestion, builtinRoute, decideRoute, jevRouteLine, keepInstructions, statusText, stepLine, summarize, modelOf, readConfig, routeStep,
  BROWSE_DESCRIPTION, BROWSE_SCHEMA, BROWSE_TIMEOUT_MS, browseCommand, browseReply, STUCK_Q, BRIEF_Q, maskSecrets, SUBAGENT_DONE_REASON, judgeBrief, fitsQuestion, pickSkill, skillFits, skillNote, skillQuestions, trimChunks, trimRequest, trimmed, approveBash, approveWrite, failureOf, judgeStuck, stuckDue, stuckState, type Failure, callSummary, clipTail, configCommand, plainRead, sanitizeSid, screen, splitList, withPolicies, withPolicyQ, TIER_LABELS, DASHBOARD, OMJ_HELP, OMJ_OFF, OMJ_ON, parseLog, toggleArg,
  type Config, type Judged, type LogEntry, type Route, type Questions, type SessionState, type Verdict,
} from './policy.ts'

type $ = EngineInterface
type Paths = { dir: string; log: string; session: string; sid: string }
type Ctx = { p: Paths; s: SessionState }

const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
const HOOKED = ['Bash', 'WebFetch', 'Read', 'Write', 'Edit', 'NotebookEdit', /^mcp__/] as const
const ASK = 'mcp__ohmyjev__ask_jev'
const BROWSE = 'mcp__ohmyjev__browse'
const FIND = 'mcp__ohmyjev__find_code'
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
async function askJev($: $, c: Config, raw: unknown, questions: Questions, timeoutMs: number) {
  const k = await keyOf($, c)
  if (!k) throw new JevError('no key', true)
  const state = c.maskSecrets ? maskSecrets(raw, (await $.env.get('HOME')) ?? '') : raw
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
    $.ui.status(statusText(s, Date.now(), c.enabled))
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
let lastBlocked = '' // the call a gate denied this turn
const approved = new Set<string>() // calls Jev cleared as safe: the permission check may skip asking the person
const approvalKey = (kind: string, input: unknown): string => `${kind}\u0000${arg(input, 'command') || arg(input, 'file_path') || arg(input, 'notebook_path') || arg(input, 'path')}`
let blockedBefore = '' // what was denied in the turn before this request: a "yes" confirms it
let proseRules: Rule[] | 'pending' | 'none' = 'none' // the instruction files' writing rules, once extracted
let proseAt = -1 // request count when the writing-rule check last asked for a rewrite: once per request
const briefs = new Map<string, string>() // a subagent's brief by its id, for its done-check
const briefsSentBack = new Set<string>() // briefs sent back once; the same brief again goes through
let failures: Failure[] = [] // this request's failed tool calls, for the stuck check
let stuckAskedAt = 0 // how many failures there were when the stuck check last asked
let userRequest = '' // the user's latest message: the gates ask whether it asked for the call
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

/** A Jev verdict as the deny text, remembering the denied call so the user's next "yes" can confirm it. */
function blocked(j: Judged, tool: string, input: unknown): string | undefined {
  if (j.verdict !== 'deny') return undefined
  lastBlocked = callSummary(tool, input)
  return denyText(j.reason)
}

async function gate($: $, e: { tool: string }): Promise<string | undefined> {
  const tool = String(e.tool)
  const kind = kindOf(tool)
  const cwd = await $.session.cwd()
  if (kind === 'Bash' && c.bashGate) {
    const command = arg(e, 'command')
    if (plainRead(command, c)) {
      if (c.autoApprove) approved.add(approvalKey(kind, e)) // ls, git status, grep: code says read-only, no Jev call
      return undefined
    }
    const state = { command: clip(command, CLIP), cwd, description: clip(arg(e, 'description'), 300), ...(command.length > CLIP ? { truncated: true } : {}) }
    const d = await decide($, 'tool.call', tool, withPolicies(state, c, userRequest, blockedBefore), withPolicyQ(BASH_Q, c, userRequest))
    if (!d) return undefined
    const j = gateBash(d.answers, c)
    record($, d, j.verdict, j.reason)
    if (j.verdict === null && approveBash(d.answers, c)) approved.add(approvalKey(kind, e))
    return blocked(j, tool, e)
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
    const d = await decide($, 'tool.call', tool, withPolicies({ path, content: clip(content, CLIP) }, c, userRequest, blockedBefore), withPolicyQ(WRITE_Q, c, userRequest))
    if (!d) return undefined
    const j = gateWrite(d.answers, c)
    record($, d, j.verdict, j.reason)
    if (j.verdict === null && approveWrite(d.answers, c)) approved.add(approvalKey(kind, e))
    return blocked(j, tool, e)
  }
  if ((kind === 'WebFetch' || kind.startsWith('mcp__')) && c.exfilGate) {
    const { tool: _t, tool_use_id: _id, consent: _c, ...input } = e as Record<string, unknown>
    const state = withPolicies({ tool, input: clip(JSON.stringify(input), 4000) }, c, userRequest, blockedBefore)
    const d = await decide($, 'tool.call', tool, state, withPolicyQ(EXFIL_Q, c, userRequest))
    if (!d) return undefined
    const j = gateExfil(d.answers, c)
    record($, d, j.verdict, j.reason)
    return blocked(j, tool, e)
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

// --- output trim (after the tool ran): a long Bash output cut to what the request needs ---

async function trimResult($: $, e: { tool: string }, r: ToolCallResult): Promise<ToolCallResult> {
  const res = r.result as { stdout?: unknown } | undefined
  if (!c.trimOutput || e.tool !== 'Bash' || typeof res?.stdout !== 'string') return r
  const chunks = trimChunks(res.stdout, c)
  if (!chunks.length) return r
  const { state, questions } = trimRequest(userRequest, chunks)
  const d = await decide($, 'tool.result', 'trim', state, questions)
  if (!d) return r
  const out = trimmed(chunks, d.answers, c)
  record($, d, null, out ? `trimmed ${res.stdout.length} to ${out.length} characters` : 'kept whole')
  if (!out) return r
  say($, `trimmed Bash output from ${res.stdout.length} to ${out.length} characters`)
  return { ...r, result: { ...res, stdout: out } as never, text: r.text?.includes(res.stdout) ? r.text.replace(res.stdout, out) : out }
}

/** A transcript's tool calls with their outcome and the end of their output, for a subagent's done-check. */
function toolRecord(log: string) {
  const calls = new Map<string, { tool: string; input: string; outcome: string; output: string }>()
  for (const line of log.split('\n')) {
    let m: { message?: { content?: unknown } }
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
      const block = b as { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
      if (block.type === 'tool_use' && block.id) calls.set(block.id, { tool: String(block.name), input: clip(JSON.stringify(block.input ?? {}), 200), outcome: 'pending', output: '' })
      if (block.type === 'tool_result' && block.tool_use_id && calls.has(block.tool_use_id)) {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
        Object.assign(calls.get(block.tool_use_id)!, { outcome: block.is_error ? 'failed' : 'ok', output: clipTail(text, 300) })
      }
    }
  }
  return [...calls.values()].slice(-20)
}

// --- writing-rule check: the final reply against the instruction files' writing rules, rewritten once ---

/** The writing rules in CLAUDE.md and AGENTS.md (repo, then ~/.claude), extracted by a small model once per version. */
async function loadProseRules($: $): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const root = (await $.session.root()) ?? (await $.session.cwd())
  const files: Array<{ path: string; text: string }> = []
  for (const path of [`${root}/CLAUDE.md`, `${root}/AGENTS.md`, `${root}/.claude/CLAUDE.md`, `${home}/.claude/CLAUDE.md`]) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text === 'string' && text.trim()) files.push({ path, text: text.slice(0, 40_000) })
  }
  if (!files.length) return void (proseRules = 'none')
  const x = await session($)
  const cache = `${x.p.dir}/rules-${filesHash(files)}.json`
  const cached = await $.fs.read(cache).catch(() => undefined)
  const fromCache = typeof cached === 'string' ? parseRules(cached) : undefined
  if (fromCache) return void (proseRules = fromCache.length ? fromCache : 'none')
  proseRules = 'pending'
  const reply = await $.model.complete({ model: 'haiku', prompt: extractionPrompt(files), maxTokens: 4000 }).catch(() => '')
  const rules = parseRules(reply)
  if (!rules) return void (proseRules = 'none')
  void $.fs.write(cache, JSON.stringify(rules)).catch(() => undefined)
  proseRules = rules.length ? rules : 'none'
  if (rules.length) say($, `writing-rule check: ${rules.length} rules from ${files.map(f => f.path.split('/').slice(-2).join('/')).join(', ')}`)
}

/** The rewrite request when the reply breaks a writing rule at 0.85 or more; null otherwise. */
async function proseCheck($: $, reply: string): Promise<string | null> {
  if (!c.proseCheck || reply.trim().length < MIN_REPLY || !Array.isArray(proseRules)) return null
  const rules = proseRules
  const d = await decide($, 'Stop', 'prose', { response: clip(reply, 6000) }, ruleQuestions(rules))
  if (!d) return null
  const bad = broken(d.answers, rules)
  record($, d, bad.length ? 'block' : null, bad.length ? `writing rules broken: ${bad.length}` : 'writing rules ok')
  return bad.length ? rewriteReason(bad) : null
}

// --- fast compaction: Jev keeps the messages that matter, verbatim, instead of a model writing a summary ---

const blockOf = (m: SessionMessage): string =>
  [m.text, ...m.toolUses.map(t => `[tool_use ${t.tool}] ${JSON.stringify(t.input ?? {}).slice(0, 400)}`), ...(m.toolResults ?? []).map(r => `[tool_result] ${String(r.text ?? '').slice(0, 800)}`)]
    .filter(Boolean).join('\n').trim()

async function fastCompact($: $, messages: readonly SessionMessage[], directive: string) {
  const started = Date.now()
  const rows = messages.map(m => ({ m, text: blockOf(m) })).filter(r => judgeable(r.m.role, r.text))
  const blocks: Block[] = rows.map(r => ({ role: r.m.role, text: r.text }))
  const kept = await select(async (state, questions) => {
    const d = await decide($, 'session.compact', 'compact', state, questions)
    if (!d) return null
    record($, d, null, 'compaction checks')
    return d.answers
  }, blocks, directive)
  if (!kept) return null
  const before = blocks.reduce((n, b) => n + b.text.length, 0)
  const after = kept.reduce((n, k) => n + k.text.length, 0)
  const out: SessionMessage[] = [{ role: 'user', text: COMPACT_HEADER, toolUses: [] }]
  for (const k of kept) {
    const m = rows[k.i]!.m
    // a plain message kept whole stands as the engine's own; anything with tools or cut is rebuilt as text
    out.push(!k.truncated && !m.toolUses.length && !m.toolResults?.length && k.text === rows[k.i]!.text ? m : { role: m.role, text: k.text, toolUses: [] })
  }
  const x = await session($)
  x.s.compactions++
  writeSession($, x.p, x.s)
  return { messages: out, line: `fast compaction: kept ${kept.length} of ${blocks.length} messages verbatim, ${Math.round((1 - after / Math.max(before, 1)) * 100)}% smaller, ${Date.now() - started} ms` }
}

// --- read narrowing (before the tool runs): a big Read cut to the part the request points at ---

async function narrowCall($: $, e: Record<string, unknown>) {
  if (e.offset !== undefined || e.limit !== undefined) return null
  const path = pathOf(e)
  const cwd = await $.session.cwd()
  if (!path || !(await pathAllowed($, path, cwd, false))) return null
  const abs = absolute(path, cwd, (await $.env.get('HOME')) ?? '')
  const text = await $.fs.read(abs).catch(() => undefined)
  if (typeof text !== 'string') return null
  const n = await narrowRead(await codeIO($, String(e.tool)), userRequest, abs, text)
  if (n) say($, `narrowed Read of ${path} to lines ${n.offset}-${n.offset + n.limit - 1}`)
  return n && { path, n }
}

// --- stuck check (after the tool ran): the same approach failing over and over ---

async function checkStuck($: $, e: { tool: string }, r: ToolCallResult): Promise<ToolCallResult> {
  if (!c.stuckCheck || !r.isError) return r
  const { tool: _t, tool_use_id: _id, ...input } = e as Record<string, unknown>
  failures.push(failureOf(String(e.tool), input, r.text))
  if (!stuckDue(failures.length, stuckAskedAt)) return r
  stuckAskedAt = failures.length
  const d = await decide($, 'tool.result', 'stuck', stuckState(userRequest, failures), STUCK_Q)
  if (!d) return r
  const note = judgeStuck(d.answers, c, failures.length)
  record($, d, note ? 'flag' : null, note ? 'stuck' : 'not stuck')
  return note ? { ...r, context: [...(r.context ?? []), note] } : r
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
    folder: { type: 'string', description: 'With type noul: ask the question of every source file under this repo folder; returns only the files that answer yes, with the line' },
    state: { type: 'string', description: 'Any other text Jev should judge' },
  },
  required: ['question', 'type'],
}
const ASK_FILE = 8000
const ASK_TOTAL = 80000

/** The code tools' I/O: repo files listed by git (else find), read through $.fs, every Jev call logged like a gate's. */
async function codeIO($: $, tool: string): Promise<CodeIO> {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  return {
    list: async dir => {
      const abs = absolute(dir, cwd, home)
      const git = await $.process.run(['git', '-C', abs, 'ls-files', '--cached', '--others', '--exclude-standard', '--full-name'], { timeoutMs: 10_000 }).catch(() => undefined)
      const top = git?.exitCode === 0 ? await $.process.run(['git', '-C', abs, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => undefined) : undefined
      if (git?.exitCode === 0 && top?.exitCode === 0)
        return git.stdout.split('\n').filter(Boolean).map(p => `${top.stdout.trim()}/${p}`).filter(p => p.startsWith(abs.replace(/\/$/, '') + '/'))
      const found = await $.process.run(['find', abs, '-type', 'f'], { timeoutMs: 10_000 }).catch(() => undefined)
      return found?.stdout.split('\n').filter(Boolean) ?? []
    },
    read: async p => {
      const text = await $.fs.read(p).catch(() => undefined)
      return typeof text === 'string' ? text : undefined
    },
    ask: async (state, questions) => {
      const d = await decide($, 'ask_jev', tool, state, questions)
      if (!d) return null
      record($, d, null, 'code question')
      return d.answers
    },
  }
}

/** find_code: files that carry out a described behaviour, inside the repo. */
async function answerFind($: $, e: Record<string, unknown>): Promise<ToolCallResult> {
  const reply = (v: unknown): ToolCallResult => ({ result: JSON.stringify(v) })
  if (!c.findCode) return reply({ error: 'find_code is off: /omj config findCode on' })
  const goal = typeof e.goal === 'string' ? e.goal.trim() : ''
  if (!goal) return reply({ error: 'goal is required' })
  const cwd = await $.session.cwd()
  const dir = typeof e.path === 'string' && e.path.trim() ? e.path.trim() : (await $.session.root()) ?? cwd
  if (!(await pathAllowed($, dir, cwd, false))) return reply({ error: `${dir} is outside the repo` })
  const io = await codeIO($, FIND)
  const r = await find(io, goal, await io.list(dir))
  return reply(r.skipped ? { error: r.skipped } : { files_scanned: r.files, matches: r.hits.length ? r.hits : 'no match' })
}

async function answerAsk($: $, e: Record<string, unknown>): Promise<ToolCallResult> {
  const reply = (v: unknown): ToolCallResult => ({ result: JSON.stringify(v) })
  const q = buildQuestion(e)
  if (typeof q === 'string') return reply({ error: q })
  if (typeof e.folder === 'string' && e.folder.trim()) {
    if (e.type !== 'noul') return reply({ error: 'a folder sweep asks a yes/no question: use type noul' })
    const cwd0 = await $.session.cwd()
    if (!(await pathAllowed($, e.folder, cwd0, false))) return reply({ error: `${e.folder} is outside the repo` })
    const io = await codeIO($, ASK)
    const r = await sweep(io, String(e.question), await io.list(e.folder))
    return reply(r.skipped ? { error: r.skipped } : { files_asked: r.files, yes: r.yes.length ? r.yes : 'none' })
  }
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

/** browse: jev-ultrafast in the user's Chrome; the answer is the tool's result, screened like any MCP output. */
async function runBrowse($: $, e: Record<string, unknown>): Promise<ToolCallResult> {
  const reply = (text: string): ToolCallResult => ({ result: text, text })
  if (!c.browse) return reply(JSON.stringify({ error: 'browse is off: /omj config browse on' }))
  const env = {
    TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
    OPENROUTER_API_KEY: await $.env.get('OPENROUTER_API_KEY'),
    TEXT_MODEL_API_KEY: await $.env.get('TEXT_MODEL_API_KEY'),
  }
  const cmd = browseCommand(e, c, env)
  if (typeof cmd === 'string') return reply(JSON.stringify({ error: cmd }))
  const r = await $.process.run(cmd.argv, { env: cmd.env, timeoutMs: BROWSE_TIMEOUT_MS }).catch((err: unknown) => ({ stdout: '', stderr: String(err) }))
  return reply(browseReply(r.stdout, r.stderr))
}

/** /omj: this session's status and log summary, and where the key comes from (never the key). */
async function jevReport($: $): Promise<string> {
  const x = await session($)
  const log = await $.fs.read(x.p.log).catch(() => '')
  const k = await keyOf($, c)
  return [
    statusText(x.s, Date.now(), c.enabled),
    summarize(typeof log === 'string' ? log : ''),
    `key: ${k ? `${k.source} · ${k.provider} · ${k.model}` : 'none (set TYPESAFE_API_KEY or the apiKey setting)'}`,
  ].join('\n')
}

/** /omj stats: every session's log as one page at ~/.ohmyjev/dashboard.html, opened in the browser. */
async function openDashboard($: $): Promise<string> {
  const x = await session($)
  // ponytail: cat of every log; trim the directory if it ever grows past what one page should show
  const logs = await $.process.run(['sh', '-c', 'cat "$0"/log/*.jsonl 2>/dev/null', x.p.dir], { timeoutMs: 5000 }).catch(() => undefined)
  const path = `${x.p.dir}/${DASHBOARD}`
  await $.fs.write(path, dashboardHtml(parseLog(logs?.stdout ?? ''), { now: Date.now(), sid: x.p.sid, source: 'claude code' }))
  const opened = await $.process.run(['sh', '-c', 'open "$0" 2>/dev/null || xdg-open "$0"', path], { timeoutMs: 5000 }).catch(() => undefined)
  return `dashboard: ${path}${opened?.exitCode === 0 ? ' (opened in your browser)' : ' (open it in a browser)'}`
}

/** /omj and /ohmyjev: the report, `stats`, `settings`, or `on`/`off` for this session (the enabled setting is the default). */
async function runCommand($: $, args: string): Promise<string> {
  const a = args.trim()
  if (a === 'stats') return openDashboard($)
  if (a === 'settings' || a === 'config' || a.startsWith('config ')) {
    const r = configCommand(c, a.replace(/^(settings|config)/, ''), 'To keep a change, use /plugin configure ohmyjev@ohmyjev, then /reload-plugins.')
    c = r.c
    showStatus($, (await session($)).s)
    return r.text
  }
  const enabled = toggleArg(a)
  if (enabled !== undefined) {
    c = { ...c, enabled }
    if (!enabled) {
      route = undefined
      compactPending = false
    }
    showStatus($, (await session($)).s)
    return enabled ? OMJ_ON : OMJ_OFF
  }
  return a ? OMJ_HELP : jevReport($)
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
  approved.clear()
  proseRules = 'none'
  proseAt = -1
  briefs.clear()
  briefsSentBack.clear()
  failures = []
  stuckAskedAt = 0
  userRequest = ''
  lastBlocked = ''
  blockedBefore = ''
  compactPending = false
  saidStepFor = ''

  on('turn.start', async ($, e, next) => {
    if (e.text.trim() && !/^\/\S+\s*$/.test(e.text.trim())) {
      userRequest = e.text
      failures = []
      stuckAskedAt = 0
      blockedBefore = lastBlocked
      lastBlocked = ''
    }
    if (c.enabled) await classify($, e.text)
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

  on('agent.spawn', async ($, e, next) => {
    // a brief that changes files without saying where, what done looks like, or how to check: sent back once
    if (c.enabled && c.subagentCheck && !e.fork && !briefsSentBack.has(e.prompt)) {
      const d = await decide($, 'agent.spawn', e.subagentType, { brief: clip(e.prompt, 4000), description: clip(e.description, 200) }, BRIEF_Q)
      const sendBack = d ? judgeBrief(d.answers) : null
      if (d) record($, d, sendBack ? 'block' : null, sendBack ? 'brief sent back' : 'brief ok')
      if (sendBack) {
        briefsSentBack.add(e.prompt)
        return { deny: sendBack }
      }
    }
    const routed = route && c.routeSubagents && !e.model && !e.fork && e.subagentType === 'general-purpose' ? modelOf(route.tier, c) : undefined
    if (routed) say($, `subagent → ${routed} (${route!.tier})`)
    const r = await next(routed ? { ...e, model: routed } : e)
    if (r.agentId) briefs.set(r.agentId, e.prompt)
    return r
  }).catch(($, e, next) => next(e))

  // a subagent's "done" checked against its own tool record, once
  on('classic.SubagentStop', async ($, e, next) => {
    const r = await next(e)
    if (!c.enabled || !c.subagentCheck || e.stop_hook_active || !e.agent_transcript_path) return r
    const log = await $.fs.read(e.agent_transcript_path).catch(() => '')
    const tools = typeof log === 'string' ? toolRecord(log) : []
    const state = { current_request: clip(briefs.get(e.agent_id) ?? '', 600), previous_requests: [], tools_this_turn: tools, last_assistant_message: clip(e.last_assistant_message, 1500) }
    const d = await decide($, 'SubagentStop', e.agent_type, state, STOP_Q)
    if (!d) return r
    const j = judgeStop(d.answers, c, tools.length > 0)
    record($, d, j.block ? 'block' : null, j.block ? 'subagent done unverified' : 'subagent stop ok')
    return j.block ? { ...r, block: SUBAGENT_DONE_REASON } : r
  })

  on('session.start', async ($, e, next) => {
    if (c.askJev) await $.tool.register({ name: 'ask_jev', description: ASK_DESCRIPTION, inputSchema: ASK_SCHEMA }).catch(() => undefined)
    if (c.browse) await $.tool.register({ name: 'browse', description: BROWSE_DESCRIPTION, inputSchema: BROWSE_SCHEMA }).catch(() => undefined)
    if (c.enabled && c.proseCheck && (await keyOf($, c))) void loadProseRules($).catch(() => undefined)
    if (c.findCode) await $.tool.register({ name: 'find_code', description: FIND_DESCRIPTION, inputSchema: FIND_SCHEMA }).catch(() => undefined)
    for (const name of ['omj', 'ohmyjev'])
      await $.command.register({ name, description: "ohmyjev: this session's Jev calls, denies, cost and key source; stats opens the dashboard; on/off for this session", argumentHint: '[stats|config [name value]|on|off]' }).catch(() => undefined)
    const k = await keyOf($, c)
    say(
      $,
      !c.enabled
        ? 'off (the enabled setting): every call passes through. /omj on turns it on for this session.'
        : k
          ? `ready: Jev via ${k.provider} (${k.model}, key from ${k.source})`
          : `no Jev key: gates and screens let every call through${c.routeWithoutKey ? '; routing uses the built-in classifier, up only' : ''}. Set TYPESAFE_API_KEY or the apiKey setting.`,
    )
    const x = await session($)
    showStatus($, k ? x.s : { ...x.s, noKey: true })
    return next(e)
  }).catch(($, e, next) => next(e))

  /** Skill picker: the skill listing stays out of the main conversation while Jev picks (a key is set). */
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (e.agentId || !c.enabled || !c.skillPick || !(await keyOf($, c))) return next(e)
    return { text: null }
  }).catch(($, e, next) => next(e))

  /** ...and names the one skill this request needs, beside the prompt. */
  on('prompt.submit', async ($, e, next) => {
    const own = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
    if (!c.enabled || !c.skillPick || !own || /^\/\S/.test(e.text.trim()) || !(await keyOf($, c))) return next(e)
    const skills = (await $.command.list().catch(() => []))
      .filter(s => (s.source === 'user' || s.source === 'plugin') && s.name !== 'omj' && s.name !== 'ohmyjev')
    if (!skills.length) return next(e)
    const d = await decide($, 'prompt.submit', 'skill', { request: clip(e.text, 1500) }, skillQuestions(skills))
    if (!d) return next(e)
    const pick = pickSkill(d.answers, c)
    record($, d, null, pick ? `skill ${pick.name} (${pick.confidence.toFixed(2)}, needs a skill ${pick.gate.toFixed(2)})` : 'no skill')
    const skill = pick && skills.find(s => s.name === pick.name)
    if (!pick || !skill) return next(e)
    const f = await decide($, 'prompt.submit', 'skill', { request: clip(e.text, 1500) }, fitsQuestion(skill))
    if (!f) return next(e)
    const fits = skillFits(f.answers, c)
    record($, f, null, `${pick.name} fits ${String((f.answers.fits as { noul?: number }).noul ?? 0)}`)
    if (!fits) return next(e)
    say($, `skill: ${pick.name} (${pick.confidence.toFixed(2)})`)
    return next({ ...e, context: [...(e.context ?? []), skillNote(pick.name)] })
  }).catch(($, e, next) => next(e))

  /** Auto-approve: where the engine would stop to ask the person, a call Jev already cleared runs instead. */
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision !== 'ask' || r.ceiling === 'ask' || !c.enabled || !c.autoApprove) return r
    const key = approvalKey(kindOf(e.tool), e.input)
    if (!approved.has(key)) return r
    approved.delete(key)
    say($, `approved ${e.tool}: Jev rated it safe, so no prompt`)
    return { decision: 'allow', reason: 'ohmyjev: Jev rated this call safe' }
  }).catch(($, e, next) => next(e))

  for (const command of ['omj', 'ohmyjev'])
    on('command.run', { command }, async ($, e) => ({ text: await runCommand($, e.args) })).catch(($, e, next) => next(e))

  on('tool.call', { tool: HOOKED }, async ($, e, next) => {
    if (e.tool === ASK) return answerAsk($, e as Record<string, unknown>)
    if (e.tool === FIND) return answerFind($, e as Record<string, unknown>)
    if (c.enabled && c.readNarrow && kindOf(String(e.tool)) === 'Read') {
      const narrowed = await narrowCall($, e as Record<string, unknown>)
      if (narrowed) {
        const r = await screenResult($, e, await next({ ...e, offset: narrowed.n.offset, limit: narrowed.n.limit } as typeof e))
        return { ...r, context: [...(r.context ?? []), narrowNote(narrowed.path, narrowed.n)] }
      }
    }
    if (e.tool === BROWSE) {
      const denied = c.enabled && c.browse ? await gate($, e) : undefined // the exfil gate: a goal that carries local data out
      if (denied) return { deny: denied }
      const r = await runBrowse($, e as Record<string, unknown>)
      return c.enabled ? screenResult($, e, r) : r
    }
    if (!c.enabled) return next(e)
    const denied = await gate($, e)
    if (denied) return { deny: denied }
    return checkStuck($, e, await screenResult($, e, await trimResult($, e, await next(e))))
  }).catch(($, e, next) => next(e)) // a bug of ours passes through

  // --- done-check: once per request; the user's own Stop hooks run first ---

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (!c.enabled || e.stop_hook_active || !(c.doneCheck || c.autoCompact || c.proseCheck)) return r
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
        .flatMap(m => m.toolUses.map(t => ({ tool: t.tool, input: clip(JSON.stringify(t.input), 200), outcome: outcomeOf(t), output: clipTail(t.text, 300) })))
        .slice(-20),
      last_assistant_message: clip(e.last_assistant_message ?? msgs.filter(m => m.role === 'assistant').at(-1)?.text, 1500),
    }
    liveRequest = state.current_request
    const questions = state.previous_requests.length ? { ...STOP_Q, ...SWITCHED_Q } : STOP_Q
    const d = await decide($, 'Stop', '', state, questions)
    if (!d) return r
    const j = judgeStop(d.answers, c, state.tools_this_turn.length > 0)
    const block = c.doneCheck ? j.block : null
    if (block) pushedBackAt = requests.length
    if (c.autoCompact && j.wantsCompact) compactPending = true
    record($, d, block ? 'block' : null, block ?? (j.wantsCompact ? 'task switched' : 'stop ok'))
    if (block) return { ...r, block }
    const rewrite = proseAt === requests.length ? null : await proseCheck($, e.last_assistant_message ?? msgs.filter(m => m.role === 'assistant').at(-1)?.text ?? '')
    if (rewrite) proseAt = requests.length
    return rewrite ? { ...r, block: rewrite } : r
  })

  // --- auto-compact: after a turn, once the task switched and the context is full enough ---

  on('session.measure', async ($, e, next) => {
    if (c.enabled && c.autoCompact && compactPending && (e.context.percent ?? 0) >= c.compactMinPercent) {
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
  on('session.compact', async ($, e, next) => {
    const instructions = e.trigger === 'auto' && liveRequest ? [e.instructions, keepInstructions(liveRequest)].filter(Boolean).join('\n\n') : e.instructions
    const core = () => next(instructions === e.instructions ? e : { ...e, instructions })
    if (!c.enabled || !c.fastCompact || e.agentId || e.trigger === 'precompute' || !(await keyOf($, c))) return core()
    const fast = await fastCompact($, e.messages, [instructions, liveRequest].filter(Boolean).join('\n'))
    if (!fast) return core()
    say($, fast.line)
    return { messages: fast.messages }
  }).catch(($, e, next) => next(e))

  on('session.end', ($, e, next) => {
    ctx = undefined
    pushedBackAt = -1
    route = undefined
    liveRequest = ''
    approved.clear()
    proseRules = 'none'
    proseAt = -1
    briefs.clear()
    briefsSentBack.clear()
    failures = []
    stuckAskedAt = 0
  userRequest = ''
  lastBlocked = ''
  blockedBefore = ''
    compactPending = false
    saidStepFor = ''
    return next(e)
  })
}
