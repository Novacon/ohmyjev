/**
 * ohmyjev for Codex: one command hook, run once per event (codex/hooks.json). Each run is a fresh process, so what
 * must outlive it (the user's latest request, the call blocked last turn, this turn's tools) sits in
 * ~/.ohmyjev/codex/<session>.json. Same decisions as the other hosts (hooks/policy.ts); every failure prints nothing,
 * and nothing lets the call through. Codex hooks can't change the model or add tools, so there is no router or ask_jev.
 * Built to codex/ohmyjev.mjs with `bun run build:codex`, since Codex runs it with plain node.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  BASH_Q, EXFIL_Q, SCREEN_Q, STOP_Q, WRITE_Q, applyPatchPaths, approveBash, approveWrite, callSummary, clip, clipTail, denyText, gateBash, gateExfil, gateWrite,
  judgeStop, pathDenyText, plainRead, readConfig, sanitizeSid, screen, withPolicies, withPolicyQ, type Config,
} from '../hooks/policy.ts'
import { Session, keyOf, newStuck, pathAllowed, repoRoot, stuckNote, trimOutput, type Env, type Fetch, type Stuck } from './shared.ts'

const CLIP = 16000
type Tool = { tool: string; input: string; outcome: 'ok' | 'failed'; output: string }
type State = { request: string; previous: string[]; count: number; blockedBefore: string; lastBlocked: string; tools: Tool[]; pushedBackAt: number; approved: string[]; stuck: Stuck }
const EMPTY: State = { request: '', previous: [], count: 0, blockedBefore: '', lastBlocked: '', tools: [], pushedBackAt: -1, approved: [], stuck: { failures: [], askedAt: 0 } }
/** A call Jev cleared, as PermissionRequest will see it again. */
const approvalKey = (tool: string, input: Input): string => `${tool}\u0000${str(input, 'command')}`
type Input = Record<string, unknown>
const str = (o: Input, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
const obj = (v: unknown): Input => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Input) : {})

/** Settings: ~/.codex/ohmyjev.json, a flat object of the setting names in the README. */
async function config(env: Env): Promise<Config> {
  const text = await readFile(`${env.HOME ?? ''}/.codex/ohmyjev.json`, 'utf8').catch(() => '{}')
  try {
    return readConfig(obj(JSON.parse(text)))
  } catch {
    return readConfig({})
  }
}

const statePath = (env: Env, sid: string) => `${env.HOME ?? ''}/.ohmyjev/codex/${sanitizeSid(sid)}.json`
async function load(env: Env, sid: string): Promise<State> {
  const text = await readFile(statePath(env, sid), 'utf8').catch(() => '')
  try {
    return { ...EMPTY, ...(JSON.parse(text) as Partial<State>) }
  } catch {
    return { ...EMPTY }
  }
}
// ponytail: last write wins; two hooks finishing at once can drop one tool from this turn's list (done-check input only)
async function save(env: Env, sid: string, st: State): Promise<void> {
  await mkdir(`${env.HOME ?? ''}/.ohmyjev/codex`, { recursive: true, mode: 0o700 }).catch(() => undefined)
  await writeFile(statePath(env, sid), JSON.stringify(st), { mode: 0o600 }).catch(() => undefined)
}

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

/** One hook event in, Codex's JSON answer out; undefined means no opinion. */
export async function handle(input: Input, env: Env, fetchImpl?: Fetch): Promise<object | undefined> {
  const c = await config(env)
  const event = str(input, 'hook_event_name')
  const sid = str(input, 'session_id') || 'codex'
  const cwd = str(input, 'cwd') || process.cwd()
  if (!c.enabled) return undefined

  if (event === 'SessionStart')
    return keyOf(c, env) ? undefined : { systemMessage: 'ohmyjev: no Jev key, so every call passes through. Set TYPESAFE_API_KEY in the shell that starts Codex.' }

  const st = await load(env, sid)
  if (event === 'UserPromptSubmit') {
    const prompt = str(input, 'prompt')
    if (!prompt.trim() || /^\/\S+\s*$/.test(prompt.trim())) return undefined
    if (st.request) st.previous = [...st.previous, clip(st.request, 200)].slice(-5)
    Object.assign(st, { request: prompt, count: st.count + 1, blockedBefore: st.lastBlocked, lastBlocked: '', tools: [], stuck: newStuck() })
    await save(env, sid, st)
    return undefined
  }

  const x = new Session(c, env, sid, undefined, fetchImpl)
  const tool = str(input, 'tool_name')
  const toolInput = obj(input.tool_input)

  if (event === 'PreToolUse') {
    const approve = async () => {
      if (!c.autoApprove) return undefined
      st.approved = [...st.approved, approvalKey(tool, toolInput)].slice(-20)
      await save(env, sid, st)
      return undefined
    }
    const blocked = async (j: { verdict: unknown; reason: string }, safe = false) => {
      if (j.verdict === null && safe) return approve()
      if (j.verdict !== 'deny') return undefined
      st.lastBlocked = callSummary(tool, toolInput)
      await save(env, sid, st)
      return deny(denyText(j.reason))
    }
    if (tool === 'Bash' && c.bashGate) {
      const command = str(toolInput, 'command')
      if (plainRead(command, c)) return approve()
      const state = withPolicies({ command: clip(command, CLIP), cwd, ...(command.length > CLIP ? { truncated: true } : {}) }, c, st.request, st.blockedBefore)
      const d = await x.decide('tool.call', tool, state, withPolicyQ(BASH_Q, c, st.request))
      if (!d) return undefined
      const j = gateBash(d.answers, c)
      x.record(d, j.verdict, j.reason)
      return blocked(j, approveBash(d.answers, c))
    }
    if (tool === 'apply_patch' && c.writeGate) {
      const patch = str(toolInput, 'command')
      const root = await repoRoot(cwd)
      for (const path of applyPatchPaths(patch))
        if (!(await pathAllowed(path, cwd, root, c, env))) {
          x.denyByCode(tool, `${path} is outside the repo and allowPaths`)
          return deny(pathDenyText(path))
        }
      const state = withPolicies({ path: applyPatchPaths(patch).join('; '), content: clip(patch, CLIP) }, c, st.request, st.blockedBefore)
      const d = await x.decide('tool.call', tool, state, withPolicyQ(WRITE_Q, c, st.request))
      if (!d) return undefined
      const j = gateWrite(d.answers, c)
      x.record(d, j.verdict, j.reason)
      return blocked(j, approveWrite(d.answers, c))
    }
    if (tool.startsWith('mcp__') && c.exfilGate) {
      const state = withPolicies({ tool, input: clip(JSON.stringify(toolInput), 4000) }, c, st.request, st.blockedBefore)
      const d = await x.decide('tool.call', tool, state, withPolicyQ(EXFIL_Q, c, st.request))
      if (!d) return undefined
      const j = gateExfil(d.answers, c)
      x.record(d, j.verdict, j.reason)
      return blocked(j)
    }
    return undefined
  }

  if (event === 'PermissionRequest') {
    const key = approvalKey(tool, toolInput)
    if (!c.autoApprove || !st.approved.includes(key)) return undefined
    st.approved = st.approved.filter(k => k !== key)
    await save(env, sid, st)
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  }

  if (event === 'PostToolUse') {
    const response = input.tool_response
    const code = obj(response).exit_code ?? obj(response).exitCode
    const r = obj(response)
    const shown = typeof response === 'string' ? response : typeof r.output === 'string' ? r.output : typeof r.stdout === 'string' ? r.stdout : JSON.stringify(response ?? '')
    st.tools = [...st.tools, { tool, input: clip(JSON.stringify(toolInput), 200), outcome: typeof code === 'number' && code !== 0 ? 'failed' : 'ok', output: clipTail(shown, 300) } as Tool].slice(-20)
    const failed = typeof code === 'number' && code !== 0
    const stuck = failed ? await stuckNote(x, st.stuck, st.request, tool, toolInput, shown) : null
    await save(env, sid, st)
    const notes = stuck ? [stuck] : []
    // a cut output replaces the result: Codex hooks can't edit it, but a PostToolUse block's reason stands in for it
    const cut = tool === 'Bash' ? await trimOutput(x, st.request, shown) : null
    if (cut) return { decision: 'block', reason: [cut, ...notes].join('\n') }
    const context = () => (notes.length ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n') } } : undefined)
    if (!c.injectionScreen || !(tool === 'Bash' || tool.startsWith('mcp__')) || !shown.trim()) return context()
    const d = await x.decide('tool.result', tool, { tool, content: clip(shown, 6000) }, SCREEN_Q)
    if (!d) return context()
    const s = screen(d.answers, c)
    x.record(d, s.flagged ? 'flag' : null, s.reason)
    if (s.flagged) notes.push(s.note)
    return context()
  }

  if (event === 'Stop') {
    if (!c.doneCheck || input.stop_hook_active === true || st.pushedBackAt === st.count) return undefined
    const state = {
      current_request: clip(st.request, 600),
      previous_requests: st.previous,
      tools_this_turn: st.tools,
      last_assistant_message: clip(str(input, 'last_assistant_message'), 1500),
    }
    const d = await x.decide('Stop', '', state, STOP_Q)
    if (!d) return undefined
    const j = judgeStop(d.answers, c, st.tools.length > 0)
    x.record(d, j.block ? 'block' : null, j.block ?? 'stop ok')
    if (!j.block) return undefined
    st.pushedBackAt = st.count
    await save(env, sid, st)
    return { decision: 'block', reason: j.block }
  }
  return undefined
}

/** The hook command: one JSON event on stdin, the answer on stdout. Any failure prints nothing, so Codex goes on. */
export async function main(): Promise<void> {
  try {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    const out = await handle(obj(JSON.parse(text)), process.env)
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {
    // ohmyjev's own bug: no opinion
  }
}
