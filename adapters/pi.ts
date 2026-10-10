import { readFile } from 'node:fs/promises'
import {
  BASH_Q, EXFIL_Q, ROUTE_Q, SCREEN_Q, STOP_Q, SWITCHED_Q, WRITE_Q,
  TIER_LABELS, builtinRoute, clip, decideRoute, denyText, gateBash, gateExfil, gateWrite, jevRouteLine, judgeStop, pathDenyText,
  OMJ_HELP, OMJ_OFF, OMJ_ON, settingsRows, toggleArg,
  keepInstructions, readConfig, routeStep, screen, stepLine, withPolicies, withPolicyQ,
  type Config, type Route,
} from '../hooks/policy.ts'
import {
  ASK_DESCRIPTION, ASK_SCHEMA, Session, answerAsk, keyOf, pathAllowed, repoRoot,
  type Env, type Fetch,
} from './shared.ts'

type MaybePromise<T> = T | Promise<T>
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type TextContent = { type: 'text'; text: string }
type ImageContent = { type: 'image'; data: string; mimeType: string }
type Content = TextContent | ImageContent

type HostMessage = {
  role: string
  content?: string | Array<Record<string, unknown>>
  toolCallId?: string
  toolName?: string
  isError?: boolean
  timestamp?: number
}

type HostModel = {
  id: string
  provider: string
  reasoning?: boolean
  input?: string[]
  cost?: { input?: number; output?: number }
}

export type PiContext = {
  cwd: string
  isProjectTrusted(): boolean
  signal?: AbortSignal
  ui: {
    setStatus(key: string, text: string | undefined): void
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
  sessionManager: { getSessionId(): string }
  model?: HostModel
  modelRegistry: {
    getAvailable(): HostModel[]
    find(provider: string, modelId: string): HostModel | undefined
    complete(
      model: HostModel,
      context: { systemPrompt?: string; messages: HostMessage[] },
      options?: { maxTokens?: number; signal?: AbortSignal; cacheRetention?: string },
    ): Promise<{ content: Content[]; stopReason?: string }>
  }
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined
  compact(options?: { customInstructions?: string; onComplete?: () => void; onError?: (error: Error) => void }): void
}

type HostEvent = Record<string, unknown>
type HostHandler = (event: HostEvent, ctx: PiContext) => MaybePromise<unknown>

type ToolDefinition = {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiContext,
  ): Promise<{ content: Content[]; details?: unknown }>
}

export type PiExtensionAPI = {
  on(event: string, handler: HostHandler): () => void
  registerTool(tool: ToolDefinition): void
  registerCommand(name: string, command: { description?: string; handler(args: string, ctx: PiContext): Promise<void> }): void
  setModel(model: HostModel): Promise<boolean>
  getThinkingLevel(): ThinkingLevel
  setThinkingLevel(level: ThinkingLevel): void
}

type ToolCallEvent = HostEvent & {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

type ToolResultEvent = HostEvent & {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  content: Content[]
  structuredContent?: unknown
  isError: boolean
}

type BeforeAgentStartEvent = HostEvent & { type: 'before_agent_start'; prompt: string }
type ThinkingLevelSelectEvent = HostEvent & {
  type: 'thinking_level_select'
  level: ThinkingLevel
  previousLevel: ThinkingLevel
}
type BoundaryEvent = HostEvent & {
  type: 'agent_before_settle'
  entries: Array<Record<string, unknown>>
  continue: boolean
  outcome: 'completed' | 'aborted' | 'error'
  context: { contextMessages: HostMessage[]; canContinue: boolean }
}

export type PiAdapterOptions = {
  env?: Env
  fetchImpl?: Fetch
  /** Test/embedder override. Normal extension loads always read Pi settings files. */
  config?: Partial<Config>
  cwd?: string
}

const CLIP = 16_000
const entry = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const arg = (input: Record<string, unknown>, key: string): string => typeof input[key] === 'string' ? input[key] : ''
const json = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => entry(part).type === 'text' && typeof entry(part).text === 'string' ? [entry(part).text as string] : []).join('\n')
}

async function readSettings(cwd: string, env: Env, projectTrusted: boolean): Promise<Config> {
  const parse = async (path: string | undefined): Promise<Record<string, unknown>> => {
    if (!path) return {}
    try {
      const settings = entry(JSON.parse(await readFile(path, 'utf8')))
      return entry(settings.ohmyjev)
    } catch {
      return {}
    }
  }
  const global = await parse(env.HOME ? `${env.HOME}/.pi/agent/settings.json` : undefined)
  const project = projectTrusted ? await parse(`${cwd}/.pi/settings.json`) : {}
  return readConfig({ ...global, ...project })
}

const guarded = <E extends HostEvent, R>(handler: (event: E, ctx: PiContext) => MaybePromise<R | void>): HostHandler =>
  async (event, ctx) => {
    try {
      return await handler(event as E, ctx)
    } catch {
      return undefined
    }
  }

function messagesForStop(messages: HostMessage[]) {
  const requests = messages.filter(message => message.role === 'user' && textOf(message.content).trim() !== '')
  let lastRequest = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'user' && textOf(message.content).trim() !== '') {
      lastRequest = i
      break
    }
  }

  const tools: Array<{ id: string; tool: string; input: string; outcome: 'ok' | 'failed' | 'pending' }> = []
  const byId = new Map<string, (typeof tools)[number]>()
  for (const message of messages.slice(lastRequest + 1)) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        const block = entry(part)
        if (block.type !== 'toolCall' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
        const call = { id: block.id, tool: block.name, input: clip(json(block.arguments), 200), outcome: 'pending' as const }
        tools.push(call)
        byId.set(call.id, call)
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = byId.get(message.toolCallId)
      if (call) call.outcome = message.isError ? 'failed' : 'ok'
    }
  }

  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant')
  return {
    count: requests.length,
    state: {
      current_request: clip(textOf(requests.at(-1)?.content), 600),
      previous_requests: requests.slice(-6, -1).map(message => clip(textOf(message.content), 200)),
      tools_this_turn: tools.slice(-20).map(({ tool, input, outcome }) => ({ tool, input, outcome })),
      last_assistant_message: clip(textOf(lastAssistant?.content), 1500),
    },
  }
}

function resolveModel(registry: PiContext['modelRegistry'], spec: string): HostModel | undefined {
  const slash = spec.indexOf('/')
  if (slash > 0) return registry.find(spec.slice(0, slash), spec.slice(slash + 1))
  const matches = registry.getAvailable().filter(model => model.id === spec)
  return matches.length === 1 ? matches[0] : undefined
}

function cheapestModel(ctx: PiContext, c: Config): HostModel | undefined {
  const configured = resolveModel(ctx.modelRegistry, c.fastModel)
  if (configured) return configured
  const candidates = ctx.modelRegistry.getAvailable().filter(model => !model.input || model.input.includes('text'))
  const priced = candidates.filter(model => Number.isFinite(model.cost?.input) && Number.isFinite(model.cost?.output))
  const pricedPlain = priced.filter(model => model.reasoning === false)
  const unpricedPlain = candidates.filter(model => model.reasoning === false)
  const pool = pricedPlain.length ? pricedPlain : priced.length ? priced : unpricedPlain.length ? unpricedPlain : candidates
  return [...pool].sort((a, b) =>
    ((a.cost?.input ?? Number.POSITIVE_INFINITY) + (a.cost?.output ?? Number.POSITIVE_INFINITY))
    - ((b.cost?.input ?? Number.POSITIVE_INFINITY) + (b.cost?.output ?? Number.POSITIVE_INFINITY))
    || a.id.localeCompare(b.id))[0]
}

/** Pi 0.87 has no classifier model API; use the cheapest available chat model and accept only an exact rubric label. */
async function classifyBuiltin(ctx: PiContext, c: Config, request: string): Promise<Route | undefined> {
  if (!c.routeWithoutKey) return undefined
  const model = cheapestModel(ctx, c)
  if (!model) return undefined
  const labels = TIER_LABELS.map(label => `- ${label}`).join('\n')
  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: `Classify the request. Reply with exactly one of these labels and nothing else:\n${labels}`,
      messages: [{ role: 'user', content: clip(request, 1500), timestamp: Date.now() }],
    },
    {
      maxTokens: 64,
      signal: AbortSignal.any([AbortSignal.timeout(c.timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]),
      cacheRetention: 'none',
    },
  )
  if (response.stopReason === 'error') return undefined
  const label = response.content.filter((part): part is TextContent => part.type === 'text').map(part => part.text).join('').trim()
  return builtinRoute(label)
}

export function createExtension(options: PiAdapterOptions = {}) {
  return async (pi: PiExtensionAPI): Promise<void> => {
    const env: Env = options.env ?? process.env
    const initialCwd = options.cwd ?? process.cwd()
    let c = options.config ? readConfig(options.config) : await readSettings(initialCwd, env, false)
    let session: Session | undefined
    let root = initialCwd
    let latestCtx: PiContext | undefined
    let pushedBackAt = -1
    let route: Route | undefined
    let liveRequest = ''
    let userRequest = '' // the user's latest message: the gates ask whether it asked for the call
    let compactPending = false
    let userThinking: ThinkingLevel = 'medium'
    let changingThinking = false
    let askRegistered = false

    const status = (): void => {
      if (!c.statusLine || !session || !latestCtx) return
      try {
        latestCtx.ui.setStatus('ohmyjev', session.status(Date.now(), c.enabled))
      } catch {}
    }
    const say = (ctx: PiContext, line: string): void => {
      if (!c.logDecisions) return
      try {
        ctx.ui.notify(`[ohmyjev] ${line}`, 'info')
      } catch {}
    }
    const ensureSession = async (ctx: PiContext): Promise<Session> => {
      latestCtx = ctx
      if (session) return session
      if (!options.config) c = await readSettings(ctx.cwd, env, ctx.isProjectTrusted())
      root = await repoRoot(ctx.cwd)
      session = new Session(c, env, ctx.sessionManager.getSessionId(), status, options.fetchImpl)
      status()
      return session
    }
    const reset = (): void => {
      session = undefined
      latestCtx = undefined
      pushedBackAt = -1
      route = undefined
      liveRequest = ''
      userRequest = ''
      compactPending = false
    }
    const setThinking = (level: ThinkingLevel): void => {
      if (pi.getThinkingLevel() === level) return
      changingThinking = true
      try {
        pi.setThinkingLevel(level)
      } finally {
        changingThinking = false
      }
    }
    const restoreThinking = (): void => setThinking(userThinking)

    const applyRoute = async (ctx: PiContext, selected: Route): Promise<void> => {
      const x = await ensureSession(ctx)
      const before = { model: ctx.model?.id ?? '', effort: userThinking }
      const planned = routeStep(selected, before, c)
      let modelApplied = false
      if (planned.patch.model) {
        const model = resolveModel(ctx.modelRegistry, planned.patch.model)
        if (model) {
          changingThinking = true
          try {
            modelApplied = await pi.setModel(model)
          } finally {
            changingThinking = false
          }
        } else say(ctx, `main loop kept ${before.model || 'current model'}: configured model ${planned.patch.model} is not in Pi's available model registry`)
      }
      if (planned.patch.effort) setThinking(planned.patch.effort)
      const effectiveConfig = modelApplied || !planned.patch.model ? c : { ...c, routeMainModel: false }
      const applied = routeStep(selected, before, effectiveConfig)
      const line = stepLine(selected, before, applied.label, effectiveConfig)
      if (line) say(ctx, line)
      x.noteRoute(applied.label)
    }

    const registerAsk = (): void => {
      if (askRegistered || !c.askJev) return
      pi.registerTool({
        name: 'ask_jev',
        label: 'Ask Jev',
        description: ASK_DESCRIPTION,
        // Pi 0.87 exposes no TypeBox builder on ExtensionAPI. Its loader accepts an object schema and its validator
        // compiles standard JSON Schema, so the shared raw schema is the portable no-runtime-import form.
        parameters: ASK_SCHEMA,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          try {
            if (!c.askJev) return { content: [{ type: 'text', text: JSON.stringify({ error: 'ask_jev is disabled' }) }], details: undefined }
            const x = await ensureSession(ctx)
            const answer = await answerAsk(x, params, ctx.cwd, root)
            return { content: [{ type: 'text', text: answer }], details: undefined }
          } catch {
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'jev unavailable: answer from your own reading' }) }], details: undefined }
          }
        },
      })
      askRegistered = true
    }

    /** /omj and /ohmyjev: the report, `settings`, or `on`/`off` for this session (the enabled setting is the default). */
    const command = async (args: string, ctx: PiContext): Promise<void> => {
      try {
        const x = await ensureSession(ctx)
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
        } else if (a === 'stats') ctx.ui.notify(await x.dashboard('pi'), 'info')
        else ctx.ui.notify(a === 'settings' ? settingsRows(c).join('\n') : a ? OMJ_HELP : await x.report(c.enabled), 'info')
      } catch {
        ctx.ui.notify('ohmyjev report unavailable', 'warning')
      }
    }
    for (const name of ['omj', 'ohmyjev'])
      pi.registerCommand(name, { description: "ohmyjev: this session's Jev calls, denies, cost and key source; stats opens the dashboard; on/off for this session", handler: command })

    pi.on('session_start', guarded(async (_event, ctx) => {
      reset()
      latestCtx = ctx
      userThinking = pi.getThinkingLevel()
      const x = await ensureSession(ctx)
      registerAsk()
      const key = keyOf(c, env)
      say(
        ctx,
        key
          ? `ready: Jev via ${key.provider} (${key.model}, key from ${key.source})`
          : `no Jev key: gates and screens let every call through${c.routeWithoutKey ? '; routing uses Pi\'s cheapest available model classifier, up only' : ''}. Set TYPESAFE_API_KEY or the apiKey setting.`,
      )
      ctx.ui.setStatus('ohmyjev', c.statusLine ? x.status(Date.now(), c.enabled) : undefined)
    }))

    pi.on('thinking_level_select', guarded<ThinkingLevelSelectEvent, void>((event) => {
      if (!changingThinking) userThinking = event.level
    }))

    pi.on('session_shutdown', guarded((_event, ctx) => {
      try {
        restoreThinking()
        ctx.ui.setStatus('ohmyjev', undefined)
      } finally {
        reset()
      }
    }))

    pi.on('before_agent_start', guarded<BeforeAgentStartEvent, void>(async (event, ctx) => {
      latestCtx = ctx
      if (event.prompt.trim() && !/^\/\S+\s*$/.test(event.prompt.trim())) userRequest = event.prompt
      if (!c.enabled) return
      const text = event.prompt
      if (!text.trim()) return
      restoreThinking()
      route = undefined
      if (!(c.routeEffort || c.routeMainModel) || /^\/\S+\s*$/.test(text.trim())) return
      const x = await ensureSession(ctx)
      if (keyOf(c, env)) {
        const d = await x.decide('turn.start', '', { request: clip(text, 1500) }, ROUTE_Q)
        if (!d) return
        route = decideRoute(d.answers, c)
        say(ctx, jevRouteLine(d.answers, d.e.ms))
        x.record(d, null, `${route.tier} (${route.tierConf?.toFixed(2) ?? 'n/d'}), ${route.effort} (${route.effortConf?.toFixed(2) ?? 'n/d'})`)
      } else {
        route = await classifyBuiltin(ctx, c, text)
        if (!route) return
        say(ctx, `built-in classifier (no Jev key): tier ${route.tier}, effort ${route.effort}; no confidence, so it only routes up`)
        x.log({ event: 'turn.start', tool: '', verdict: null, reason: `builtin: ${route.tier}, ${route.effort}` })
      }
      await applyRoute(ctx, route)
    }))

    pi.on('tool_call', guarded<ToolCallEvent, { block: true; reason: string }>(async (event, ctx) => {
      latestCtx = ctx
      if (!c.enabled) return
      const x = await ensureSession(ctx)
      const tool = event.toolName
      const input = event.input
      if ((tool === 'bash' || tool === 'powershell') && c.bashGate) {
        const command = arg(input, 'command')
        const state = withPolicies({ command: clip(command, CLIP), cwd: ctx.cwd, ...(command.length > CLIP ? { truncated: true } : {}) }, c, userRequest)
        const d = await x.decide('tool.call', tool, state, withPolicyQ(BASH_Q, c, userRequest))
        if (!d) return
        const judged = gateBash(d.answers, c)
        x.record(d, judged.verdict, judged.reason)
        if (judged.verdict === 'deny') return { block: true, reason: denyText(judged.reason) }
        return
      }
      if ((tool === 'write' || tool === 'edit') && c.writeGate) {
        const path = arg(input, 'path')
        if (!(await pathAllowed(path, ctx.cwd, root, c, env))) {
          x.denyByCode(tool, `${path} is outside the repo and allowPaths`)
          return { block: true, reason: pathDenyText(path) }
        }
        const content = tool === 'write' ? arg(input, 'content') : json(input.edits)
        const d = await x.decide('tool.call', tool, withPolicies({ path, content: clip(content, CLIP) }, c, userRequest), withPolicyQ(WRITE_Q, c, userRequest))
        if (!d) return
        const judged = gateWrite(d.answers, c)
        x.record(d, judged.verdict, judged.reason)
        if (judged.verdict === 'deny') return { block: true, reason: denyText(judged.reason) }
        return
      }
      if (tool.startsWith('mcp__') && c.exfilGate) {
        const d = await x.decide(
          'tool.call',
          tool,
          withPolicies({ tool, input: clip(json(input), 4000) }, c, userRequest),
          withPolicyQ(EXFIL_Q, c, userRequest),
        )
        if (!d) return
        const judged = gateExfil(d.answers, c)
        x.record(d, judged.verdict, judged.reason)
        if (judged.verdict === 'deny') return { block: true, reason: denyText(judged.reason) }
      }
    }))

    pi.on('tool_result', guarded<ToolResultEvent, { content: Content[]; structuredContent?: unknown }>(async (event, ctx) => {
      latestCtx = ctx
      if (!c.enabled) return
      const tool = event.toolName
      const shell = tool === 'bash' || tool === 'powershell'
      if (!c.injectionScreen || (event.isError && !shell)) return
      const candidate = shell || tool.startsWith('mcp__') || tool === 'read'
      if (!candidate) return
      if (tool === 'read') {
        if (!c.screenReads || await pathAllowed(arg(event.input, 'path'), ctx.cwd, root, c, env)) return
      }
      const content = event.content.filter((part): part is TextContent => part.type === 'text').map(part => part.text).join('\n')
      if (!content.trim()) return
      const x = await ensureSession(ctx)
      const d = await x.decide('tool.result', tool, { tool, content: clip(content, 6000) }, SCREEN_Q)
      if (!d) return
      const judged = screen(d.answers, c)
      x.record(d, judged.flagged ? 'flag' : null, judged.reason)
      if (!judged.flagged) return
      return {
        content: [...event.content, { type: 'text', text: judged.note }],
        ...(Object.hasOwn(event, 'structuredContent') ? { structuredContent: event.structuredContent } : {}),
      }
    }))

    pi.on('agent_before_settle', guarded<BoundaryEvent, { entries: Array<Record<string, unknown>>; continue: true }>(async (event, ctx) => {
      latestCtx = ctx
      if (!c.enabled || event.outcome !== 'completed' || event.continue || !event.context.canContinue || !(c.doneCheck || c.autoCompact)) return
      const { count, state } = messagesForStop(event.context.contextMessages)
      if (!count || count === pushedBackAt) return
      liveRequest = state.current_request
      const x = await ensureSession(ctx)
      const questions = state.previous_requests.length ? { ...STOP_Q, ...SWITCHED_Q } : STOP_Q
      const d = await x.decide('Stop', '', state, questions)
      if (!d) return
      const judged = judgeStop(d.answers, c, state.tools_this_turn.length > 0)
      const block = c.doneCheck ? judged.block : null
      if (block) pushedBackAt = count
      if (c.autoCompact && judged.wantsCompact) compactPending = true
      x.record(d, block ? 'block' : null, block ?? (judged.wantsCompact ? 'task switched' : 'stop ok'))
      if (!block) return
      return {
        entries: [...event.entries, { type: 'custom_message', customType: 'ohmyjev', content: block, display: true }],
        continue: true,
      }
    }))

    pi.on('agent_settled', guarded(async (_event, ctx) => {
      latestCtx = ctx
      restoreThinking()
      if (!c.autoCompact || !compactPending) return
      const percent = ctx.getContextUsage()?.percent ?? 0
      if (percent < c.compactMinPercent) return
      compactPending = false
      const x = await ensureSession(ctx)
      x.s.compactions++
      x.save()
      x.log({ event: 'agent_settled', tool: '', verdict: 'compact', reason: `${percent}% after a task switch` })
      ctx.compact({ customInstructions: keepInstructions(liveRequest) })
    }))
  }
}

export default createExtension()
