/**
 * ohmyjev for Codex: one command hook, run once per event (codex/hooks.json). Each run is a fresh process, so what
 * must outlive it (the user's latest request, the call blocked last turn, this turn's tools) sits in
 * ~/.ohmyjev/codex/<session>.json. Same decisions as the other hosts (hooks/policy.ts); every failure prints nothing,
 * and nothing lets the call through. Codex hooks can't change the model or add tools, so there is no router or ask_jev.
 * Built to codex/ohmyjev.mjs with `bun run build:codex`, since Codex runs it with plain node.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  BASH_Q, EXFIL_Q, SCREEN_Q, STOP_Q, WRITE_Q, applyPatchPaths, callSummary, clip, denyText, gateBash, gateExfil, gateWrite,
  judgeStop, pathDenyText, plainRead, readConfig, sanitizeSid, screen, withPolicies, withPolicyQ, type Config,
} from '../hooks/policy.ts'
import { Session, keyOf, pathAllowed, repoRoot, type Env, type Fetch } from './shared.ts'

const CLIP = 16000
type Tool = { tool: string; input: string; outcome: 'ok' | 'failed' }
type State = { request: string; previous: string[]; count: number; blockedBefore: string; lastBlocked: string; tools: Tool[]; pushedBackAt: number }
const EMPTY: State = { request: '', previous: [], count: 0, blockedBefore: '', lastBlocked: '', tools: [], pushedBackAt: -1 }
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
    Object.assign(st, { request: prompt, count: st.count + 1, blockedBefore: st.lastBlocked, lastBlocked: '', tools: [] })
    await save(env, sid, st)
    return undefined
  }

  const x = new Session(c, env, sid, undefined, fetchImpl)
  const tool = str(input, 'tool_name')
  const toolInput = obj(input.tool_input)

  if (event === 'PreToolUse') {
    const blocked = async (j: { verdict: unknown; reason: string }) => {
      if (j.verdict !== 'deny') return undefined
      st.lastBlocked = callSummary(tool, toolInput)
      await save(env, sid, st)
      return deny(denyText(j.reason))
    }
    if (tool === 'Bash' && c.bashGate) {
      const command = str(toolInput, 'command')
      if (plainRead(command, c)) return undefined
      const state = withPolicies({ command: clip(command, CLIP), cwd, ...(command.length > CLIP ? { truncated: true } : {}) }, c, st.request, st.blockedBefore)
      const d = await x.decide('tool.call', tool, state, withPolicyQ(BASH_Q, c, st.request))
      if (!d) return undefined
      const j = gateBash(d.answers, c)
      x.record(d, j.verdict, j.reason)
      return blocked(j)
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
      return blocked(j)
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

  if (event === 'PostToolUse') {
    const response = input.tool_response
    const code = obj(response).exit_code ?? obj(response).exitCode
    st.tools = [...st.tools, { tool, input: clip(JSON.stringify(toolInput), 200), outcome: typeof code === 'number' && code !== 0 ? 'failed' : 'ok' } as Tool].slice(-20)
    await save(env, sid, st)
    if (!c.injectionScreen || !(tool === 'Bash' || tool.startsWith('mcp__'))) return undefined
    const text = typeof response === 'string' ? response : JSON.stringify(response ?? '')
    if (!text.trim()) return undefined
    const d = await x.decide('tool.result', tool, { tool, content: clip(text, 6000) }, SCREEN_Q)
    if (!d) return undefined
    const s = screen(d.answers, c)
    x.record(d, s.flagged ? 'flag' : null, s.reason)
    return s.flagged ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: s.note } } : undefined
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
