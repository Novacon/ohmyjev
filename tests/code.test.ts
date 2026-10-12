import { expect, test } from 'claude-code/testing'
import { find, locate, narrowRead, skeleton, sourceFile, sweep, windowOf, type CodeIO } from '../hooks/code.ts'
import type { Answers, Questions } from '../hooks/policy.ts'

const big = Array.from({ length: 600 }, (_, i) => (i === 420 ? 'export function rotatePhoto(img) {' : `const x${i} = ${i}`)).join('\n')
const io = (answer: (q: Questions, state: any) => Answers | null, files: Record<string, string> = {}): CodeIO => ({
  list: async () => Object.keys(files),
  read: async p => files[p],
  ask: async (state, q) => answer(q, state),
})
const pick = (q: Questions, conf: number) => {
  const crit = (q.where as { criteria: Record<string, string> }).criteria
  const id = Object.keys(crit).find(k => crit[k]!.startsWith('lines 421-'))!
  return { where: { type: 'choice' as const, choice: id, confidence: conf } }
}

test('narrowRead: a confident pick becomes a window around it; small files, vague picks and short goals read whole', async () => {
  const n = await narrowRead(io(q => pick(q, 0.85)), 'where do we rotate uploaded photos', 'a.ts', big)
  expect(n).toMatchObject({ limit: 150, line: 421 })
  expect(n!.offset).toBeLessThanOrEqual(421)
  expect(n!.offset + n!.limit).toBeGreaterThan(421)
  expect(await narrowRead(io(q => pick(q, 0.42)), 'where do we rotate uploaded photos', 'a.ts', big)).toBe(null)
  expect(await narrowRead(io(q => pick(q, 0.9)), 'rotate', 'a.ts', big)).toBe(null)
  expect(await narrowRead(io(q => pick(q, 0.9)), 'where do we rotate uploaded photos', 'a.ts', 'short\nfile')).toBe(null)
  expect(await narrowRead(io(() => null), 'where do we rotate uploaded photos', 'a.ts', big)).toBe(null) // Jev down: whole file
  expect(windowOf('a\nb\nc\nd', { offset: 2, limit: 2 })).toBe('     2\tb\n     3\tc')
})

test('locate maps the picked chunk back to its first line', async () => {
  expect((await locate(io(q => pick(q, 0.9)), 'g', 'a.ts', big))?.line).toBe(421)
})

test('skeleton keeps declarations; sourceFile drops dependencies, builds, binaries and lockfiles', () => {
  const sk = skeleton(['// header', 'import x from "y"', 'const a = 1', '  doThing()', 'export function save() {', '  return 1', '}', 'app.post("/signup", h)'].join('\n'))
  expect(sk).toContain('export function save() {')
  expect(sk).toContain('app.post("/signup", h)')
  expect(sk).not.toContain('return 1')
  for (const p of ['src/a.ts', 'web/join.html', 'api/handler.go']) expect([p, sourceFile(p)]).toEqual([p, true])
  for (const p of ['node_modules/x/a.js', 'dist/a.js', 'logo.png', 'bun.lock', 'a.min.js', '.env', 'x/testdata/a.go']) expect([p, sourceFile(p)]).toEqual([p, false])
})

test('sweep returns only the yes files, best first, with the line', async () => {
  const files = { 'src/db.ts': big, 'src/ok.ts': 'safe\ncode', 'logo.png': 'x' }
  const r = await sweep(io((q, s) => ('answer' in q ? { answer: { type: 'noul', noul: s.file.path === 'src/db.ts' ? 0.95 : 0.04 } } : pick(q, 0.8)), files), 'does this concatenate SQL?', Object.keys(files))
  expect(r.files).toBe(2)
  expect(r.yes).toEqual([{ path: 'src/db.ts', p: 0.95, line: 421 }])
})

test('find screens skeletons, verifies the top files in full, keeps 0.6 and up, and can answer no match', async () => {
  const files = { 'web/join.html': big, 'src/util.ts': 'export const pad = 1', 'src/other.ts': 'export const y = 2' }
  const seen: string[] = []
  const answer = (q: Questions, s: any) => {
    if ('where' in q) return pick(q, 0.9)
    seen.push(s.file.skeleton !== undefined ? 'skeleton' : 'content')
    return { match: { type: 'noul' as const, noul: s.file.path === 'web/join.html' ? 0.93 : 0.1 } }
  }
  const r = await find(io(answer, files), 'where is the register flow', Object.keys(files))
  expect(r.hits).toEqual([{ path: 'web/join.html', p: 0.93, verified: true, line: 421 }])
  expect(seen.filter(x => x === 'skeleton').length).toBe(3)
  expect(seen.filter(x => x === 'content').length).toBe(3)
  const none = await find(io(() => ({ match: { type: 'noul', noul: 0.05 } }), files), 'billing', Object.keys(files))
  expect(none.hits).toEqual([])
})
