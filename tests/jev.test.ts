import { expect, test } from 'claude-code/testing'
import { JevError, parseReply, pickKey, validate } from '../hooks/jev.ts'
import { noul } from '../hooks/policy.ts'

const Q = { q: { type: 'choice' as const, instructions: 'x', criteria: { a: 'A', b: 'B' } } }

test('validate rejects bad answers and never echoes the returned value', () => {
  expect(() => validate({ answers: { q: { type: 'choice', choice: 'zzz', confidence: 1 } } }, Q)).toThrow(JevError)
  expect(() => validate({ answers: { q: { type: 'choice', choice: 'constructor', confidence: 1 } } }, Q)).toThrow(JevError)
  expect(() => validate({ answers: { q: { type: 'choice', confidence: 1 } } }, Q)).toThrow(JevError)
  expect(() => validate({ answers: { q: { type: 'choice', choice: 'a', confidence: 1.5 } } }, Q)).toThrow(JevError)
  expect(() => validate({ answers: { n: { type: 'noul', noul: -0.1 } } }, { n: noul('x') })).toThrow(JevError)
  expect(() => validate({ answers: {} }, Q)).toThrow(JevError)
  expect(() => validate(null, Q)).toThrow(JevError)
  expect(() => validate({ answers: { q: { type: 'choice', choice: 'SECRET_SENTINEL', confidence: 1 } } }, Q)).not.toThrow('SECRET_SENTINEL')
  const kept = validate({ answers: { q: { type: 'choice', choice: 'a', confidence: 0.9, echo: 'payload' } } }, Q)
  expect(kept.q).toEqual({ type: 'choice', choice: 'a', confidence: 0.9 })
})

test('key order: config, then TYPESAFE, then OPENROUTER; the model follows the provider', () => {
  expect(pickKey('cfg', 'jev-1.13.0', 'ts', 'or')?.source).toBe('config apiKey')
  expect(pickKey('', 'jev-1.13.0', 'ts', 'or')).toMatchObject({ source: 'env TYPESAFE_API_KEY', model: 'jev-1.13.0' })
  expect(pickKey('', 'jev-1.13.0', undefined, 'or')).toMatchObject({ provider: 'openrouter', model: '~typesafe/jev-latest' })
  expect(pickKey('', 'jev-1.13.0')).toBe(null)
})

test('parseReply: non-2xx, non-JSON, usage', () => {
  const ok = (text: string) => ({ ok: true, status: 200, text })
  expect(() => parseReply({ ok: false, status: 500, text: '' }, 'typesafe', Q)).toThrow('HTTP 500')
  expect(() => parseReply(ok('<html>'), 'typesafe', Q)).toThrow('not JSON')
  const r = parseReply(ok(JSON.stringify({ answers: { q: { type: 'choice', choice: 'b', confidence: 0.5 } }, usage: { input_tokens: 100 } })), 'typesafe', Q)
  expect(r.inputTokens).toBe(100)
  expect(r.answers.q).toEqual({ type: 'choice', choice: 'b', confidence: 0.5 })
})
