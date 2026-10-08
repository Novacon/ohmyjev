/**
 * Jev's wire contract, pure: which key and endpoint, a strict answer check, reply parsing. The request itself goes
 * through `$` in ohmyjev.ts (the engine follows `$` only into functions declared in the hooks module's own file).
 */
import type { Answers, Questions } from './policy.ts'

export class JevError extends Error {
  constructor(message: string, readonly noKey = false) {
    super(message)
  }
}

export const ENDPOINTS = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
} as const
export type Provider = keyof typeof ENDPOINTS
export type Key = { provider: Provider; key: string; source: string; model: string }

/** Config apiKey, then $TYPESAFE_API_KEY, then $OPENROUTER_API_KEY; the model goes with the provider. */
export function pickKey(apiKey: string, jevModel: string, ts?: string, or?: string): Key | null {
  if (apiKey) return { provider: 'typesafe', key: apiKey, source: 'config apiKey', model: jevModel }
  if (ts) return { provider: 'typesafe', key: ts, source: 'env TYPESAFE_API_KEY', model: jevModel }
  if (or) return { provider: 'openrouter', key: or, source: 'env OPENROUTER_API_KEY', model: '~typesafe/jev-latest' }
  return null
}

const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/** Every question answered with its type and a probability; a choice only from our labels. Keeps validated fields only. */
export function validate(data: unknown, questions: Questions): Answers {
  const answers = (data as { answers?: unknown } | null)?.answers
  if (!answers || typeof answers !== 'object') throw new JevError('response has no answers')
  const out: Answers = {}
  for (const [id, q] of Object.entries(questions)) {
    const a = (answers as Record<string, Record<string, unknown> | undefined>)[id]
    if (!a || a.type !== q.type) throw new JevError(`missing or mistyped answer: ${id}`)
    if (q.type === 'noul') {
      if (!unit(a.noul)) throw new JevError(`${id}: noul is not a probability`)
      out[id] = { type: 'noul', noul: a.noul }
    } else if (q.type === 'score') {
      const top = q.criteria.length - 1
      if (!(typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0 && a.score <= top))
        throw new JevError(`${id}: score is not within 0..${top}`)
      if (a.confidence !== undefined && !unit(a.confidence)) throw new JevError(`${id}: confidence is not a probability`)
      out[id] = a.confidence === undefined ? { type: 'score', score: a.score } : { type: 'score', score: a.score, confidence: a.confidence }
    } else {
      if (!(typeof a.choice === 'string' && Object.hasOwn(q.criteria, a.choice))) throw new JevError(`${id}: unknown choice label`)
      if (!unit(a.confidence)) throw new JevError(`${id}: confidence is not a probability`)
      out[id] = { type: 'choice', choice: a.choice, confidence: a.confidence }
    }
  }
  return out
}

/** A finished HTTP reply to validated answers and token usage; JevError on non-2xx, non-JSON or a broken contract. */
export function parseReply(res: { ok: boolean; status: number; text: string }, provider: Provider, questions: Questions) {
  if (!res.ok) throw new JevError(`${provider}: HTTP ${res.status}`)
  let data: unknown
  try {
    data = JSON.parse(res.text)
  } catch {
    throw new JevError(`${provider}: response is not JSON`)
  }
  const answers = validate(data, questions)
  const inputTokens = Number((data as { usage?: { input_tokens?: unknown } }).usage?.input_tokens) || 0
  return { answers, inputTokens }
}
