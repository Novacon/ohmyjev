import { expect, test } from 'claude-code/testing'
import {
  DEFAULTS as c, DONE_REASON, EMPTY_SESSION, absolute, clip, expandRoot, gateBash, gateWrite, isUnder, judgeStop,
  rawAbsolute, sanitizeSid, screen, statusText, type Answers,
  BASH_Q, gateExfil, withPolicies, withPolicyQ,
} from '../hooks/policy.ts'

const bash = (effect: string, confidence: number, destructive: number): Answers => ({
  effect: { type: 'choice', choice: effect, confidence },
  destructive_intent: { type: 'noul', noul: destructive },
})
const write = (kind: string, confidence: number, secret: number): Answers => ({
  kind: { type: 'choice', choice: kind, confidence },
  contains_secret: { type: 'noul', noul: secret },
})
const nouls = (v: Record<string, number>): Answers =>
  Object.fromEntries(Object.entries(v).map(([k, noul]) => [k, { type: 'noul' as const, noul }]))

test('bash gate: deny at the thresholds, otherwise pass', () => {
  expect(gateBash(bash('irreversible', 0.6, 0.1), c).verdict).toBe('deny')
  expect(gateBash(bash('irreversible', 0.6, 0.1), c).reason).toContain('irreversible (0.60)')
  expect(gateBash(bash('irreversible', 0.59, 0.1), c).verdict).toBe(null)
  expect(gateBash(bash('read_only', 0.99, 0.7), c).verdict).toBe('deny')
  expect(gateBash(bash('reversible', 0.7, 0.3), c).verdict).toBe(null) // middling passes through (user-confirmed)
})

test('write gate', () => {
  expect(gateWrite(write('config', 0.9, 0.7), c).verdict).toBe('deny')
  expect(gateWrite(write('secrets', 0.8, 0.1), c).verdict).toBe('deny')
  expect(gateWrite(write('secrets', 0.79, 0.1), c).verdict).toBe(null)
  expect(gateWrite(write('source_code', 0.99, 0.05), c).verdict).toBe(null)
})

test('injection screen', () => {
  expect(screen(nouls({ injection: 0.93 }), c).flagged).toBe(true)
  expect(screen(nouls({ injection: 0.93 }), c).note).toContain('(0.93)')
  expect(screen(nouls({ injection: 0.69 }), c).flagged).toBe(false)
})

test('done-check judge', () => {
  const base = { claimed_done: 0.8, verified: 0.1, asks_user: 0.1 }
  expect(judgeStop(nouls(base), c)).toBe(DONE_REASON)
  expect(judgeStop(nouls({ ...base, verified: 0.3 }), c)).toBe(null)
  expect(judgeStop(nouls({ ...base, asks_user: 0.5 }), c)).toBe(null)
  expect(judgeStop(nouls({ ...base, claimed_done: 0.69 }), c)).toBe(null)
})

test('paths', () => {
  expect(absolute('src/../a.ts', '/repo', '/home/u')).toBe('/repo/a.ts')
  expect(absolute('~/.claude/x', '/repo', '/home/u')).toBe('/home/u/.claude/x')
  expect(rawAbsolute('link/../x', '/repo', '/home/u')).toBe('/repo/link/../x') // `..` left for the file system
  expect(expandRoot('$TMPDIR', '/home/u', '/private/var/t/')).toBe('/private/var/t')
  expect(expandRoot('$TMPDIR', '/home/u', undefined)).toBe(null)
  expect(expandRoot('$NOPE/x', '/home/u', '/t')).toBe(null)
  expect(expandRoot('/home/u/link/..', '/home/u', '/t')).toBe(null) // never widened to its lexical parent
  expect(isUnder('/repo/a', '/repo')).toBe(true)
  expect(isUnder('/repository', '/repo')).toBe(false)
})

test('text and status', () => {
  expect(clip('abcdef', 4)).toBe('abc…')
  expect(clip(undefined, 4)).toBe('')
  expect(sanitizeSid('../../evil')).toBe('evil')
  expect(sanitizeSid('')).toBe('unknown')
  expect(statusText({ ...EMPTY_SESSION, calls: 23, denies: 1 }, 0)).toBe('jev ✓23 ⛔1')
  expect(statusText(EMPTY_SESSION, 0)).toBe('jev ✓0')
  expect(statusText({ ...EMPTY_SESSION, downUntil: 10 }, 5)).toBe('jev ⚠ down')
  expect(statusText({ ...EMPTY_SESSION, noKey: true }, 0)).toBe('jev ⚠ no key')
})

test('exfil gate and policies', () => {
  const pc = { ...c, policies: 'no deploys; never touch prod' }
  expect(gateExfil(nouls({ exfiltrates: 0.7 }), c).verdict).toBe('deny')
  expect(gateExfil(nouls({ exfiltrates: 0.69 }), c).verdict).toBe(null)
  expect(gateExfil(nouls({ exfiltrates: 0.1, violates_policy: 0.7 }), pc).reason).toContain('breaks a listed policy (0.70)')
  expect(gateBash({ ...bash('read_only', 0.9, 0), ...nouls({ violates_policy: 0.8 }) }, pc).reason).toContain('breaks a listed policy (0.80)')
  expect(gateWrite({ ...write('docs', 0.9, 0), ...nouls({ violates_policy: 0.69 }) }, pc).verdict).toBe(null)
  expect(withPolicyQ(BASH_Q, c)).toBe(BASH_Q) // empty policies: v1's questions exactly
  expect(Object.keys(withPolicyQ(BASH_Q, pc))).toContain('violates_policy')
  expect(withPolicies({ a: 1 }, c)).toEqual({ a: 1 })
  expect(withPolicies({ a: 1 }, pc)).toEqual({ a: 1, policies: ['no deploys', 'never touch prod'] })
})
