/**
 * Fast compaction: instead of a model writing a summary (a minute or two), Jev judges each recent message and the ones
 * that still matter are kept verbatim (about a second). Ported from 0x7067/claude-jev (MIT), whose planted user
 * constraints survived every run, with its checks and limits. Pure: the host turns messages into blocks and back.
 */
import { clip, noul, type Answers, type Questions } from './policy.ts'

export type Block = { role: string; text: string }
export type Kept = { i: number; text: string; keep: number; full: number; truncated: boolean; pinned?: boolean; rescued?: boolean }

export const KEEP_AT = 0.5
export const MAX_BLOCKS = 150 // judged with every check
export const RESCUE_BLOCKS = 150 // older ones, judged for user constraints only
export const PIN_TAIL = 4 // the newest blocks always stay
const PER_REQUEST = 10
const PARALLEL = 16
const BLOCK_CHARS = 1200
const KEEP_CHARS = 1500
const HEAD = 400
const TAIL = 150
export const TARGET_CHARS = 16_000

export const CHECKS = {
  constraint: 'Does block [{i}] state a requirement, restriction, or preference from the user about how the work must be done: something not to touch, a tool or approach to use, a deadline, a scope limit?',
  decision: 'Does block [{i}] record a decision about the work together with its reason: an approach chosen, an alternative rejected, a root cause identified?',
  error: 'Does block [{i}] contain an exact error message, failing test output, or unexpected result that the agent would have to reproduce to see again?',
  open: 'Does block [{i}] name work still to be done: a next step, a pending task, or a question waiting for the user\'s answer?',
  rerunnable: 'Does block [{i}] hold output that would come back the same on a rerun: a listing, a passing check\'s log, build or install output, or warnings a rebuild would print again?',
} as const
type Check = keyof typeof CHECKS
const KEEP_CHECKS: Check[] = ['constraint', 'decision', 'error', 'open']

export const HEADER =
  "This session's history was compacted by ohmyjev. Every message below was judged still needed by Jev and kept " +
  'verbatim, or as a head and tail with an elision note; everything else was dropped. Continue the last task without ' +
  'asking the user to repeat anything.'

const META = ['<command-', '<local-command', '<system-reminder', '<caveat', '<bash-', '<task-notification']
/** A block worth judging: not engine chatter, not a bare "ok". */
export const judgeable = (role: string, text: string): boolean =>
  !!text.trim() && !META.some(p => text.trimStart().startsWith(p)) && !(role === 'user' && /^(ok|yes|no|thanks|continue)\.?$/i.test(text.trim()))

const elision = (n: number) => `[… ${n} chars elided by ohmyjev compaction; re-read the file or re-run the command if needed]`
function head(text: string, chars: number): string {
  let cut = -1
  for (let i = text.indexOf('\n\n', chars >> 1); i !== -1 && i < chars; i = text.indexOf('\n\n', i + 1)) cut = i
  return cut > 0 ? text.slice(0, cut) : text.slice(0, chars)
}
const cut = (text: string, chars: number) => (text.length <= chars ? text : `${head(text, chars)}\n${elision(text.length - head(text, chars).length)}`)
export function truncate(text: string): string {
  if (text.length <= HEAD + TAIL + 200) return text
  const h = head(text, HEAD)
  const t = text.slice(-TAIL).replace(/^\s+/, '')
  return `${h}\n${elision(text.length - h.length - t.length)}\n${t}`
}

function state(blocks: Block[], lo: number, hi: number, directive: string): string {
  const goal = blocks.filter(b => b.role === 'user').map(b => b.text.slice(0, 300)).join('\n').slice(-1500)
  return [
    'Transcript of an AI coding-assistant session being compacted.',
    `Blocks are numbered by position in the session, oldest first. This request shows blocks [${lo}]..[${hi - 1}].`,
    ...(directive ? [`The user asked this compaction to: ${clip(directive, 500)}`, 'A block that request covers counts as yes on every check below.'] : []),
    ...(goal.trim() ? [`Most recent user requests:\n${goal}`] : []),
    '',
    blocks.slice(lo, hi).map((b, k) => `[${lo + k}] [${b.role}] ${b.text.slice(0, BLOCK_CHARS)}`).join('\n\n'),
  ].join('\n')
}

/** Every check for blocks lo..hi, PER_REQUEST blocks a request, PARALLEL at a time; {} when every request failed. */
async function judge(ask: (s: unknown, q: Questions) => Promise<Answers | null>, blocks: Block[], lo: number, hi: number, directive: string, checks: Check[]): Promise<Answers> {
  const ranges: Array<[number, number]> = []
  for (let i = lo; i < hi; i += PER_REQUEST) ranges.push([i, Math.min(i + PER_REQUEST, hi)])
  let out: Answers = {}
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const got = await Promise.all(ranges.slice(i, i + PARALLEL).map(([a, b]) => {
      const q: Questions = {}
      for (let j = a; j < b; j++) for (const c of checks) q[`${c}_${j}`] = noul(CHECKS[c].replaceAll('{i}', String(j)))
      return ask(state(blocks, a, b, directive), q).catch(() => null)
    }))
    for (const a of got) if (a) out = { ...out, ...a }
  }
  return out
}

const p = (a: Answers, k: string): number | undefined => (a[k]?.type === 'noul' ? (a[k] as { noul: number }).noul : undefined)

/** The blocks to keep, in order, fit to TARGET_CHARS; null when Jev answered nothing (the host's own summary runs). */
export async function select(ask: (s: unknown, q: Questions) => Promise<Answers | null>, blocks: Block[], directive = '', target = TARGET_CHARS): Promise<Kept[] | null> {
  if (!blocks.length) return null
  const window = Math.max(0, blocks.length - MAX_BLOCKS)
  const rescueLo = Math.max(0, window - RESCUE_BLOCKS)
  const judged = Math.max(window, blocks.length - PIN_TAIL)
  const answers = judged > window ? await judge(ask, blocks, window, judged, directive, Object.keys(CHECKS) as Check[]) : {}
  if (judged > window && !Object.keys(answers).length) return null
  const rescue = window > rescueLo ? await judge(ask, blocks, rescueLo, window, directive, ['constraint']) : {}
  const kept: Kept[] = []
  for (let i = rescueLo; i < window; i++) {
    const c = p(rescue, `constraint_${i}`)
    if (c !== undefined && c >= KEEP_AT) kept.push({ i, text: cut(blocks[i]!.text, KEEP_CHARS), keep: c, full: c, truncated: false, rescued: true })
  }
  for (let i = window; i < blocks.length; i++) {
    const b = blocks[i]!
    if (i >= judged) {
      kept.push({ i, text: cut(b.text, KEEP_CHARS), keep: 1, full: 1, truncated: false, pinned: true })
      continue
    }
    const vals = KEEP_CHECKS.map(c => p(answers, `${c}_${i}`))
    if (vals.every(v => v === undefined)) {
      kept.push({ i, text: cut(b.text, KEEP_CHARS), keep: 1, full: 1, truncated: false }) // unjudged: keep
      continue
    }
    const keep = Math.max(...vals.map(v => v ?? 0))
    if (keep < KEEP_AT) continue
    const error = (p(answers, `rerunnable_${i}`) ?? 0) >= KEEP_AT ? 0 : p(answers, `error_${i}`) ?? 0
    const full = Math.max(p(answers, `constraint_${i}`) ?? 0, error)
    const short = full < KEEP_AT
    kept.push({ i, text: short ? truncate(b.text) : cut(b.text, KEEP_CHARS), keep, full, truncated: short })
  }
  const out = fit(kept, blocks, target)
  return out.length === blocks.length && out.every(k => !k.truncated) ? null : out // nothing to drop: the host compacts
}

/** Over budget: truncate the least needed full blocks, then drop the least needed; the pinned tail always stays. */
export function fit(kept: Kept[], blocks: Block[], target = TARGET_CHARS): Kept[] {
  let total = kept.reduce((n, k) => n + k.text.length, 0)
  const movable = kept.filter(k => !k.pinned)
  for (const k of [...movable].filter(k => !k.truncated).sort((a, b) => a.full - b.full)) {
    if (total <= target) break
    const short = truncate(blocks[k.i]!.text)
    if (short.length >= k.text.length) continue
    total -= k.text.length - short.length
    Object.assign(k, { text: short, truncated: true })
  }
  const dropped = new Set<Kept>()
  for (const k of [...movable].sort((a, b) => a.keep - b.keep || a.i - b.i)) {
    if (total <= target) break
    total -= k.text.length
    dropped.add(k)
  }
  return kept.filter(k => !dropped.has(k)).sort((a, b) => a.i - b.i)
}

/** The kept blocks as one text, for hosts whose compaction takes a summary string (pi). */
export const asSummary = (kept: Kept[], blocks: Block[]): string =>
  [HEADER, '', ...kept.map(k => `[${blocks[k.i]!.role}] ${k.text}`)].join('\n\n')
