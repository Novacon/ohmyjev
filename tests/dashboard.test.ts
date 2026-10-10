import { expect, test } from 'claude-code/testing'
import { dashboardHtml, esc } from '../hooks/dashboard.ts'
import type { LogEntry } from '../hooks/policy.ts'

const now = Date.UTC(2026, 9, 10, 12)
const row = (over: Partial<LogEntry>): LogEntry => ({ ts: now - 3_600_000, session: 'abcdef12-3456', event: 'tool.call', tool: 'Bash', answers: {}, ms: 300, costUsd: 0.00001, ...over })

test('the dashboard totals, groups and escapes the logs', () => {
  const html = dashboardHtml(
    [
      row({ verdict: null, reason: 'reversible (0.9)' }),
      row({ verdict: 'deny', reason: 'irreversible (0.95): <script>alert(1)</script>', ms: 900 }),
      row({ tool: 'Write', verdict: 'deny', reason: '/etc/x is outside the repo and allowPaths', answers: undefined, costUsd: undefined }),
      row({ event: 'turn.start', tool: '', verdict: null, reason: 'deep', session: 'other-session', ts: now - 40 * 86_400_000 }),
      row({ event: 'tool.result', tool: 'WebFetch', verdict: 'flag', reason: 'injection 0.93' }),
      row({ tool: 'Bash', answers: undefined, error: 'typesafe: HTTP 500' }),
    ],
    { now, sid: 'abcdef12-3456', source: 'test' },
  )
  expect(html).toContain('4 Jev calls across 2 sessions')
  expect(html).toContain('2 denies (33%), 1 injection flag, 1 error')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).toContain('<code>router</code>') // a tool-less line shows its battery
  expect(html).toContain('<code>abcdef12</code> <span class="g">this</span>')
  expect(html).toContain('2026-09-11') // the 30-day axis starts 29 days back
  expect(html).toContain('p50 latency')
  expect(esc(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&#39;')
})

test('an empty log still renders', () => {
  const html = dashboardHtml([], { now })
  expect(html).toContain('No decisions logged yet')
  expect(html).toContain('no denies')
})
