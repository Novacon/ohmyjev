/**
 * ohmyjev for omp. Host types are deliberately structural: omp injects the API at runtime and is not a dependency.
 */
import { readFile } from 'node:fs/promises'
import {
  BASH_Q, DEFAULTS, EXFIL_Q, ROUTE_Q, SCREEN_Q, STOP_Q, SWITCHED_Q, WRITE_Q,
  clip, decideRoute, denyText, gateBash, gateExfil, gateWrite, jevRouteLine, judgeStop, pathDenyText, callSummary, plainRead, configCommand, applyPatchPaths,
  OMJ_HELP, OMJ_OFF, OMJ_ON, toggleArg,
  keepInstructions, modelOf, readConfig, routeStep, screen, stepLine, withPolicies, withPolicyQ,
  type Config, type Route,
} from '../hooks/policy.ts'
import {
  ASK_DESCRIPTION, Session, answerAsk, keyOf, pathAllowed, repoRoot,
  type Env, type Fetch,
} from './shared.ts'

const CLIP = 16000
const PLUGIN = 'ohmyjev'
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true, apply_patch: true, notebook: true }
const GITHUB_READONLY_OPS: Record<string, true> = {
  repo_view: true,
  file_read: true,
  search_issues: true,
  search_prs: true,
  search_code: true,
  search_commits: true,
  search_repos: true,
  run_watch: true,
}
const SESSION_LOCAL_WRITE_SCHEMES: Record<string, true> = { local: true }
const OMP_DEFAULTS = { ...DEFAULTS, fastModel: '@smol', balancedModel: '@default', deepModel: '@slow' }

type RecordOfUnknown = Record<string, unknown>
type Content = { type: string; text?: string; [key: string]: unknown }
type HostModel = { id?: string; provider?: string; [key: string]: unknown }
type BranchEntry = {
  id?: string
  type?: string
  thinkingLevel?: string | null
  configured?: string | null
  [key: string]: unknown
}
type CompactOptions = {
  internalGuidance?: string
  suppressContinuation?: boolean
  onComplete?: (result: unknown) => void
  onError?: (error: Error) => void
}
export type HostContext = {
  cwd: string
  agent: { kind: 'main' | 'sub' }
  ui: { setStatus(key: string, text: string | undefined): void; notify(message: string, type?: 'info' | 'warning' | 'error'): void }
  sessionManager: { getSessionId(): string; getBranch(): BranchEntry[] }
  model?: HostModel
  models: { current(): HostModel | undefined; resolve(spec: string): HostModel | undefined }
  getContextUsage(): { percent?: number } | undefined
  compact(options?: string | CompactOptions): Promise<void>
  isIdle(): boolean
  setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown
}
type ToolCall = { toolName: string; input: RecordOfUnknown; [key: string]: unknown }
type ToolResult = ToolCall & { content: Content[]; isError?: boolean; details?: unknown }
type StopEvent = {
  messages: unknown[]
  last_assistant_message?: unknown
  stop_hook_active?: boolean
  session_id?: string
}
export type OmpHandler = (event: RecordOfUnknown, ctx: HostContext) => unknown | Promise<unknown>
export type OmpToolDefinition = {
  name: string
  label: string
  description: string
  parameters: unknown
  approval?: 'read' | 'write' | 'exec'
  execute(id: string, params: RecordOfUnknown, signal: AbortSignal | undefined, update: unknown, ctx: HostContext): Promise<unknown>
}
export type OmpCommandDefinition = {
  description: string
  handler(args: string, ctx: HostContext): Promise<void>
}
export type OmpApi = {
  on(event: string, handler: OmpHandler): void
  registerTool(tool: OmpToolDefinition): void
  registerCommand(name: string, command: OmpCommandDefinition): void
  typebox: {
    Type: {
      Object(properties: Record<string, unknown>): unknown
      String(options?: Record<string, unknown>): unknown
      Literal(value: string): unknown
      Union(items: unknown[], options?: Record<string, unknown>): unknown
      Array(item: unknown, options?: Record<string, unknown>): unknown
      Optional(item: unknown): unknown
    }
  }
  appendEntry(customType: string, data?: unknown): void
  getThinkingLevel(): string | undefined
  setThinkingLevel(level: string, persist?: boolean): void
  setModel(model: HostModel): Promise<boolean>
}

export type OmpExtensionOptions = {
  env?: Env
  fetchImpl?: Fetch
  /** Test/embedding override, applied after on-disk plugin settings. */
  settings?: Readonly<Record<string, unknown>>
}

const object = (value: unknown): RecordOfUnknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordOfUnknown : {}

async function jsonFile(path: string): Promise<RecordOfUnknown> {
  try {
    return object(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return {}
  }
}

/** omp does not expose plugin settings on ExtensionAPI, so mirror its documented global + project merge. */
async function configAt(cwd: string, env: Env, override?: Readonly<Record<string, unknown>>): Promise<Config> {
  const home = env.HOME ?? ''
  const globalFile = await jsonFile(`${home}/.omp/plugins/omp-plugins.lock.json`)
  const projectFile = await jsonFile(`${cwd}/.omp/plugin-overrides.json`)
  const global = object(object(globalFile.settings)[PLUGIN])
  const project = object(object(projectFile.settings)[PLUGIN])
  return readConfig({ ...OMP_DEFAULTS, ...global, ...project, ...override })
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap(part => object(part).type === 'text' && typeof object(part).text === 'string' ? [object(part).text as string] : []).join('\n')
}

const messageText = (message: unknown): string => text(object(message).content)
const string = (input: RecordOfUnknown, key: string): string => typeof input[key] === 'string' ? input[key] as string : ''
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
const isUrl = (path: string): boolean => /^https?:\/\//i.test(path)
const scheme = (path: string): string | undefined => /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)?.[1]?.toLowerCase()
const sessionLocalWrite = (path: string): boolean => SESSION_LOCAL_WRITE_SCHEMES[scheme(path) ?? ''] === true
const urlRead = (tool: string, input: RecordOfUnknown): boolean => tool === 'read' && isUrl(string(input, 'path'))
const exfilTool = (tool: string, input: RecordOfUnknown): boolean => urlRead(tool, input) || tool.startsWith('mcp__')
const githubWrite = (tool: string, input: RecordOfUnknown): boolean =>
  tool === 'github' && GITHUB_READONLY_OPS[string(input, 'op')] !== true

function writePaths(tool: string, input: RecordOfUnknown): string[] {
  const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string' && p !== '') : []
  for (const key of ['path', 'file_path', 'notebook_path']) {
    const path = string(input, key)
    if (path) paths.push(path)
  }
  if ((tool === 'edit' || tool === 'apply_patch') && typeof input.input === 'string') paths.push(...applyPatchPaths(input.input))
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const rename = string(object(edit), 'rename')
      if (rename) paths.push(rename)
    }
  }
  return [...new Set(paths)]
}

function writeContent(input: RecordOfUnknown): string {
  for (const key of ['content', 'new_string', 'new_source', 'input', 'patch']) {
    const value = string(input, key)
    if (value) return value
  }
  return safeJson(input)
}

function currentModel(ctx: HostContext): HostModel | undefined {
  return ctx.models.current() ?? ctx.model
}

function modelName(model: HostModel | undefined): string {
  if (!model) return ''
  const id = typeof model.id === 'string' ? model.id : ''
  const provider = typeof model.provider === 'string' ? model.provider : ''
  return provider && id ? `${provider}/${id}` : id
}

function sameModel(left: HostModel | undefined, right: HostModel | undefined): boolean {
  return Boolean(
    left && right &&
    typeof left.provider === 'string' && left.provider === right.provider &&
    typeof left.id === 'string' && left.id === right.id,
  )
}

function toolState(messages: unknown[], after: number): Array<{ tool: string; input: string; outcome: 'ok' | 'failed' | 'pending' }> {
  const tail = messages.slice(after)
  const outcomes = new Map<string, 'ok' | 'failed'>()
  for (const message of tail) {
    const m = object(message)
    if (m.role !== 'toolResult') continue
    const id = typeof m.toolCallId === 'string' ? m.toolCallId : ''
    if (id) outcomes.set(id, m.isError === true ? 'failed' : 'ok')
  }
  const calls: Array<{ tool: string; input: string; outcome: 'ok' | 'failed' | 'pending' }> = []
  for (const message of tail) {
    const m = object(message)
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      const p = object(part)
      if (p.type !== 'toolCall') continue
      const id = typeof p.id === 'string' ? p.id : ''
      calls.push({
        tool: typeof p.name === 'string' ? p.name : '',
        input: clip(safeJson(p.arguments), 200),
        outcome: outcomes.get(id) ?? 'pending',
      })
    }
  }
  return calls.slice(-20)
}

function askSchema(pi: OmpApi): unknown {
  const t = pi.typebox.Type
  const optionalStrings = (description: string) => t.Optional(t.Array(t.String(), { description }))
  return t.Object({
    question: t.String({ description: 'The question, about `files` and/or `state`' }),
    type: t.Union([t.Literal('noul'), t.Literal('choice'), t.Literal('score')], {
      description: 'noul = probability of yes; choice = one of options; score = a position on levels',
    }),
    options: optionalStrings('Choice labels, or 2-10 score levels from low to high'),
    files: optionalStrings('Repo file paths whose contents Jev reads'),
    state: t.Optional(t.String({ description: 'Any other text Jev should judge' })),
  })
}

/** Build a factory with injectable I/O for adapter tests; the default export uses real env/files/fetch. */
export function createExtension(options: OmpExtensionOptions = {}): (pi: OmpApi) => void {
  return (pi: OmpApi): void => {
    const env = options.env ?? process.env
    let c: Config = readConfig(OMP_DEFAULTS)
    let session: Session | undefined
    let root = ''
    let latestContext: HostContext | undefined
    let pushedBackAt = -1
    let route: Route | undefined
    let liveRequest = ''
    let lastBlocked = '' // the call a gate denied this turn
    let blockedBefore = '' // what was denied in the turn before this request: a "yes" confirms it
    let userRequest = '' // the user's latest message: the gates ask whether it asked for the call
    let compactPending = false
    let classifiedPrompt: string | undefined
    let askRegistered = false
    let sessionGeneration = 0
    let userEffort: string | undefined
    const routedThinkingEntries = new Set<string>()

    const touch = (ctx: HostContext): void => {
      latestContext = ctx
    }

    const status = (): void => {
      try {
        if (!latestContext) return
        latestContext.ui.setStatus('ohmyjev', c.statusLine && session ? session.status(Date.now(), c.enabled) : undefined)
      } catch {}
    }

    const say = (ctx: HostContext, message: string): void => {
      if (!c.logDecisions) return
      const line = `[ohmyjev] ${message}`
      try { pi.appendEntry('ohmyjev.decision', { text: line }) } catch {}
      try { ctx.ui.notify(line, 'info') } catch {}
    }

    const userThinking = (ctx: HostContext): string | undefined => {
      const branch = ctx.sessionManager.getBranch()
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]
        if (entry?.type !== 'thinking_level_change' || (entry.id && routedThinkingEntries.has(entry.id))) continue
        const configured = entry.configured ?? entry.thinkingLevel
        if (typeof configured === 'string') return configured
      }
      return userEffort ?? pi.getThinkingLevel()
    }

    const setManagedThinking = (ctx: HostContext, level: string | undefined): void => {
      if (!level || level === 'auto' || pi.getThinkingLevel() === level) return
      const before = new Set(ctx.sessionManager.getBranch().map(entry => entry.id).filter((id): id is string => typeof id === 'string'))
      pi.setThinkingLevel(level, false)
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === 'thinking_level_change' && entry.id && !before.has(entry.id)) routedThinkingEntries.add(entry.id)
      }
    }

    const restoreUserThinking = (ctx: HostContext): void => {
      userEffort = userThinking(ctx)
      setManagedThinking(ctx, userEffort)
    }

    const scheduleCompact = (ctx: HostContext): void => {
      const activeSession = session
      if (!activeSession || !c.autoCompact || !compactPending || ctx.agent.kind !== 'main') return
      const percent = ctx.getContextUsage()?.percent ?? 0
      if (percent < c.compactMinPercent) return
      const scheduledSession = activeSession
      const scheduledGeneration = sessionGeneration
      const guidance = keepInstructions(liveRequest)
      compactPending = false
      ctx.setTimeout(() => {
        if (session !== scheduledSession || sessionGeneration !== scheduledGeneration) return
        if (!ctx.isIdle()) {
          compactPending = true
          return
        }
        let failed = false
        const onError = (): void => {
          if (failed || session !== scheduledSession) return
          failed = true
          compactPending = true
        }
        void ctx.compact({
          internalGuidance: guidance,
          suppressContinuation: true,
          onComplete: () => {
            if (session !== scheduledSession) return
            scheduledSession.s.compactions++
            scheduledSession.save()
            scheduledSession.log({ event: 'session_stop', tool: '', verdict: 'compact', reason: `${percent}% after a task switch` })
            say(ctx, `compacted at ${percent}% after a task switch`)
          },
          onError,
        }).catch(onError)
      }, 0)
    }

    const classify = async (prompt: string, ctx: HostContext): Promise<void> => {
      if (!prompt.trim()) return
      route = undefined
      if (!(c.routeEffort || c.routeSubagents || c.routeMainModel) || /^\/\S+\s*$/.test(prompt.trim())) return
      if (!session || !keyOf(c, env)) {
        // OMP exposes model resolution and credentials, but no isolated completion API. runEphemeralTurn uses the
        // current model plus full conversation, so it is not a faithful or privacy-equivalent @smol classifier.
        return
      }
      const d = await session.decide('turn.start', '', { request: clip(prompt, 1500) }, ROUTE_Q)
      if (!d) return
      route = decideRoute(d.answers, c)
      say(ctx, jevRouteLine(d.answers, d.e.ms))
      session.record(d, null, `${route.tier} (${route.tierConf?.toFixed(2) ?? 'n/d'}), ${route.effort} (${route.effortConf?.toFixed(2) ?? 'n/d'})`)
    }

    const applyRoute = async (ctx: HostContext): Promise<void> => {
      if (!session) return
      userEffort = userThinking(ctx)
      if (!route) {
        restoreUserThinking(ctx)
        return
      }
      const model = currentModel(ctx)
      const fast = ctx.models.resolve(c.fastModel)
      const balanced = ctx.models.resolve(c.balancedModel)
      const deep = ctx.models.resolve(c.deepModel)
      const routedModelName = sameModel(model, fast)
        ? c.fastModel
        : sameModel(model, balanced)
          ? c.balancedModel
          : sameModel(model, deep)
            ? c.deepModel
            : modelName(model)
      const step = { model: routedModelName, effort: userEffort === 'auto' ? undefined : userEffort }
      const routingConfig = userEffort === 'auto' ? { ...c, routeEffort: false } : c
      const { patch, label } = routeStep(route, step, routingConfig)
      setManagedThinking(ctx, patch.effort ?? step.effort)
      if (patch.model) {
        const resolved = ctx.models.resolve(patch.model)
        if (resolved && !sameModel(model, resolved)) await pi.setModel(resolved)
      }
      const line = stepLine(route, step, label, routingConfig)
      if (line) say(ctx, line)
      session.noteRoute(label)
    }

    const initialize = async (ctx: HostContext): Promise<void> => {
      touch(ctx)
      c = await configAt(ctx.cwd, env, options.settings)
      root = await repoRoot(ctx.cwd)
      sessionGeneration++
      routedThinkingEntries.clear()
      userEffort = userThinking(ctx)
      session = new Session(c, env, ctx.sessionManager.getSessionId(), status, options.fetchImpl)
      pushedBackAt = -1
      route = undefined
      liveRequest = ''
      userRequest = ''
      lastBlocked = ''
      blockedBefore = ''
      compactPending = false
      classifiedPrompt = undefined
      status()
      const key = keyOf(c, env)
      say(ctx, key
        ? `ready: Jev via ${key.provider} (${key.model}, key from ${key.source})`
        : `no Jev key: gates and screens let every call through; OMP has no isolated @smol completion API, so no-key routing is disabled. Set TYPESAFE_API_KEY or the apiKey setting.`)
      if (c.askJev && !askRegistered) {
        pi.registerTool({
          name: 'ask_jev',
          label: 'Ask Jev',
          description: ASK_DESCRIPTION,
          parameters: askSchema(pi),
          approval: 'read',
          async execute(_id, params, _signal, _update, toolCtx) {
            try {
              touch(toolCtx)
              if (!session) return { content: [{ type: 'text', text: JSON.stringify({ error: 'jev session unavailable' }) }] }
              const cwd = toolCtx.cwd
              const answer = await answerAsk(session, params, cwd, root || await repoRoot(cwd))
              return { content: [{ type: 'text', text: answer }], details: {} }
            } catch {
              return { content: [{ type: 'text', text: JSON.stringify({ error: 'jev unavailable: answer from your own reading' }) }], details: {} }
            }
          },
        })
        askRegistered = true
      }
    }

    const reinitialize = async (ctx: HostContext): Promise<void> => {
      try {
        await initialize(ctx)
      } catch {
        // Session initialization is advisory; all later handlers fail open without it.
      }
    }

    pi.on('session_start', async (_event, ctx) => reinitialize(ctx))
    pi.on('session_switch', async (_event, ctx) => reinitialize(ctx))
    pi.on('session_branch', async (_event, ctx) => reinitialize(ctx))

    pi.on('session_shutdown', async (_event, ctx) => {
      try {
        touch(ctx)
        ctx.ui.setStatus('ohmyjev', undefined)
      } catch {}
      sessionGeneration++
      routedThinkingEntries.clear()
      userEffort = undefined
      session = undefined
      latestContext = undefined
      root = ''
      route = undefined
      liveRequest = ''
      userRequest = ''
      lastBlocked = ''
      blockedBefore = ''
      compactPending = false
      classifiedPrompt = undefined
      pushedBackAt = -1
    })

    pi.on('tool_call', async (rawEvent, ctx) => {
      try {
        touch(ctx)
        if (!session || !c.enabled) return
        const event = rawEvent as ToolCall
        const tool = event.toolName
        const input = object(event.input)
        if ((tool === 'bash' || tool === 'eval' || githubWrite(tool, input)) && c.bashGate) {
          if (tool === 'bash' && plainRead(string(input, 'command'), c)) return // code says read-only, no Jev call
          const command = tool === 'eval'
            ? string(input, 'code')
            : tool === 'github'
              ? `github ${safeJson(input)}`
              : string(input, 'command')
          const description = tool === 'eval'
            ? `${string(input, 'language')} eval: ${string(input, 'title')}`
            : tool === 'github'
              ? `GitHub ${string(input, 'op')}`
              : string(input, 'description')
          const state = {
            command: clip(command, CLIP),
            cwd: ctx.cwd,
            description: clip(description, 300),
            ...(command.length > CLIP ? { truncated: true } : {}),
          }
          const d = await session.decide('tool_call', tool, withPolicies(state, c, userRequest, blockedBefore), withPolicyQ(BASH_Q, c, userRequest))
          if (!d) return
          const judged = gateBash(d.answers, c)
          session.record(d, judged.verdict, judged.reason)
          if (judged.verdict === 'deny') {
          lastBlocked = callSummary(tool, input)
          return { block: true, reason: denyText(judged.reason) }
        }
          return
        }
        if (WRITE_TOOLS[tool] && c.writeGate) {
          const paths = writePaths(tool, input)
          if (!paths.length) {
            const reason = `could not determine a destination path for ${tool}`
            session.denyByCode(tool, reason)
            return { block: true, reason: denyText(reason) }
          }
          for (const path of paths) {
            if (!sessionLocalWrite(path) && !(await pathAllowed(path, ctx.cwd, root, c, env))) {
              session.denyByCode(tool, `${path} is outside the repo and allowPaths`)
              return { block: true, reason: pathDenyText(path) }
            }
          }
          const path = paths.join('; ')
          const d = await session.decide(
            'tool_call', tool,
            withPolicies({ path, content: clip(writeContent(input), CLIP) }, c, userRequest, blockedBefore),
            withPolicyQ(WRITE_Q, c, userRequest),
          )
          if (!d) return
          const judged = gateWrite(d.answers, c)
          session.record(d, judged.verdict, judged.reason)
          if (judged.verdict === 'deny') {
          lastBlocked = callSummary(tool, input)
          return { block: true, reason: denyText(judged.reason) }
        }
          return
        }
        if (c.exfilGate && exfilTool(tool, input)) {
          const d = await session.decide(
            'tool_call', tool,
            withPolicies({ tool, input: clip(safeJson(input), 4000) }, c, userRequest, blockedBefore),
            withPolicyQ(EXFIL_Q, c, userRequest),
          )
          if (!d) return
          const judged = gateExfil(d.answers, c)
          session.record(d, judged.verdict, judged.reason)
          if (judged.verdict === 'deny') {
          lastBlocked = callSummary(tool, input)
          return { block: true, reason: denyText(judged.reason) }
        }
        }
      } catch {
        return
      }
    })

    pi.on('tool_result', async (rawEvent, ctx) => {
      try {
        touch(ctx)
        if (!session || !c.enabled || !c.injectionScreen) return
        const event = rawEvent as ToolResult
        const tool = event.toolName
        const input = object(event.input)
        let shouldScreen = tool === 'bash' || tool === 'github' || exfilTool(tool, input)
        if (tool === 'read' && !urlRead(tool, input) && c.screenReads) {
          const path = string(input, 'path')
          shouldScreen = !sessionLocalWrite(path) && !(await pathAllowed(path, ctx.cwd, root, c, env))
        }
        if (!shouldScreen) return
        const resultText = event.content.map(part => part.type === 'text' && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n')
        if (!resultText.trim()) return
        const d = await session.decide('tool_result', tool, { tool, content: clip(resultText, 6000) }, SCREEN_Q)
        if (!d) return
        const screened = screen(d.answers, c)
        session.record(d, screened.flagged ? 'flag' : null, screened.reason)
        if (screened.flagged) return { content: [...event.content, { type: 'text', text: screened.note }] }
      } catch {
        return
      }
    })

    pi.on('session_stop', async (rawEvent, ctx) => {
      try {
        touch(ctx)
        if (!session || ctx.agent.kind !== 'main') return
        restoreUserThinking(ctx)
        if (!c.enabled) return
        if (!(c.doneCheck || c.autoCompact)) return
        const event = rawEvent as unknown as StopEvent
        if (event.stop_hook_active) {
          scheduleCompact(ctx)
          return
        }
        const messages = Array.isArray(event.messages) ? event.messages : []
        const requests = messages.filter(message => object(message).role === 'user' && messageText(message).trim() !== '')
        if (requests.length === pushedBackAt) {
          scheduleCompact(ctx)
          return
        }
        let lastRequest = -1
        for (let i = 0; i < messages.length; i++) {
          if (object(messages[i]).role === 'user' && messageText(messages[i]).trim() !== '') lastRequest = i
        }
        const previous = requests.slice(-6, -1).map(message => clip(messageText(message), 200))
        const state = {
          current_request: clip(messageText(requests.at(-1)), 600),
          previous_requests: previous,
          tools_this_turn: toolState(messages, lastRequest + 1),
          last_assistant_message: clip(messageText(event.last_assistant_message) || messageText([...messages].reverse().find(message => object(message).role === 'assistant')), 1500),
        }
        liveRequest = state.current_request
        const questions = previous.length ? { ...STOP_Q, ...SWITCHED_Q } : STOP_Q
        const d = await session.decide('Stop', '', state, questions)
        if (!d) {
          scheduleCompact(ctx)
          return
        }
        const judged = judgeStop(d.answers, c, state.tools_this_turn.length > 0)
        const block = c.doneCheck ? judged.block : null
        if (block) pushedBackAt = requests.length
        if (c.autoCompact && judged.wantsCompact) compactPending = true
        session.record(d, block ? 'block' : null, block ?? (judged.wantsCompact ? 'task switched' : 'stop ok'))
        if (block) return { decision: 'block', reason: block }
        scheduleCompact(ctx)
      } catch {
        return
      }
    })

    pi.on('before_agent_start', async (rawEvent, ctx) => {
      try {
        touch(ctx)
        if (ctx.agent.kind !== 'main' || !c.enabled) return
        userEffort = userThinking(ctx)
        const prompt = typeof rawEvent.prompt === 'string' ? rawEvent.prompt : ''
        if (prompt.trim() && !/^\/\S+\s*$/.test(prompt.trim())) {
          userRequest = prompt
          blockedBefore = lastBlocked
          lastBlocked = ''
        }
        if (!prompt.trim()) return
        if (classifiedPrompt !== prompt) {
          classifiedPrompt = prompt
          await classify(prompt, ctx)
        }
        await applyRoute(ctx)
      } catch {
        return
      }
    })

    pi.on('turn_end', async (_event, ctx) => {
      try {
        touch(ctx)
        classifiedPrompt = undefined
      } catch {
        return
      }
    })

    pi.on('before_subagent_spawn', async (rawEvent, ctx) => {
      try {
        touch(ctx)
        if (!session || !route || !c.routeSubagents || rawEvent.modelRole !== 'task') return
        const model = modelOf(route.tier, c)
        const note = `[ohmyjev] ${route.tier} request → ${model}`
        say(ctx, `subagent → ${model} (${route.tier})`)
        return { model, note }
      } catch {
        return
      }
    })

    pi.on('session.compacting', async (_event, ctx) => {
      try {
        touch(ctx)
        if (ctx.agent.kind === 'main' && liveRequest) return { context: [keepInstructions(liveRequest)] }
      } catch {
        return
      }
    })

    /** /omj and /ohmyjev: the report, `settings`, or `on`/`off` for this session (the enabled setting is the default). */
    const command = async (args: string, ctx: HostContext): Promise<void> => {
      try {
        touch(ctx)
        const a = args.trim()
        const enabled = toggleArg(a)
        if (enabled !== undefined) {
          c = { ...c, enabled }
          if (!enabled) {
            route = undefined
            compactPending = false
          }
          status()
          ctx.ui.notify(enabled ? OMJ_ON : OMJ_OFF, 'info')
        } else if (a === 'stats') ctx.ui.notify(session ? await session.dashboard('omp') : 'ohmyjev: no active session', 'info')
        else if (a === 'settings' || a === 'config' || a.startsWith('config ')) {
          const r = configCommand(c, a.replace(/^(settings|config)/, ''), 'To keep a change, run omp plugin config set ohmyjev <name> <value>.')
          c = r.c
          status()
          ctx.ui.notify(r.text, 'info')
        }
        else if (a) ctx.ui.notify(OMJ_HELP, 'info')
        else ctx.ui.notify(session ? await session.report(c.enabled) : 'ohmyjev: no active session', 'info')
      } catch {
        try { ctx.ui.notify('ohmyjev: report unavailable', 'error') } catch {}
      }
    }
    for (const name of ['omj', 'ohmyjev'])
      pi.registerCommand(name, { description: "ohmyjev: this session's Jev calls, denies, cost and key source; stats opens the dashboard; on/off for this session", handler: command })
  }
}

export default createExtension()
