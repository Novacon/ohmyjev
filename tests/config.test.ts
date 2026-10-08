import { expect, test } from 'claude-code/testing'
import { DEFAULTS, readConfig, splitList } from '../hooks/policy.ts'

test('readConfig keeps defaults and takes overrides', () => {
  const c = readConfig({ injection: 0.5, doneCheck: false })
  expect(c.injection).toBe(0.5)
  expect(c.doneCheck).toBe(false)
  expect(c.bashIrreversible).toBe(0.6)
  expect(DEFAULTS.injection).toBe(0.7)
})

test('splitList splits on ; and trims', () => {
  expect(splitList(' ~/.claude ; $TMPDIR;;/tmp ')).toEqual(['~/.claude', '$TMPDIR', '/tmp'])
  expect(splitList('')).toEqual([])
})
