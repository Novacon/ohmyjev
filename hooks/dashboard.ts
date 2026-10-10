/**
 * /omj stats: one static HTML page from every session's decision log, in ohmyjev.xyz's theme. Pure: the hosts read the
 * logs, write the page to ~/.ohmyjev/dashboard.html and open it. Nothing on the page leaves the machine except the
 * four font files, fetched from ohmyjev.xyz (system fonts stand in when offline).
 */
import type { LogEntry } from './policy.ts'

const FONTS = 'https://ohmyjev.xyz/fonts'
const DAYS = 30

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10)
const when = (ts: number): string => new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
const money = (usd: number): string => `$${usd.toFixed(usd >= 0.01 ? 2 : 4)}`
const pct = (n: number, of: number): number => (of ? Math.round((n / of) * 100) : 0)
const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
/** What a line was about: the tool, or the battery for lines with no tool. */
const what = (r: LogEntry): string =>
  r.tool || ({ 'turn.start': 'router', Stop: 'done-check', 'session.measure': 'auto-compact', 'tool.result': 'screen', ask_jev: 'ask_jev' } as Record<string, string>)[r.event] || r.event

type Stat = { calls: number; denies: number; flags: number; cost: number }
const stat = (): Stat => ({ calls: 0, denies: 0, flags: 0, cost: 0 })
const isDeny = (r: LogEntry) => r.verdict === 'deny' || r.verdict === 'block'

export function dashboardHtml(rows: LogEntry[], opts: { now: number; sid?: string; source?: string }): string {
  const calls = rows.filter(r => r.answers)
  const ms = calls.map(r => r.ms ?? 0).sort((a, b) => a - b)
  const denies = rows.filter(isDeny)
  const total = { ...stat(), calls: calls.length, denies: denies.length, flags: rows.filter(r => r.verdict === 'flag').length, cost: calls.reduce((n, r) => n + (r.costUsd ?? 0), 0) }
  const errors = rows.filter(r => r.error).length
  const compactions = rows.filter(r => r.verdict === 'compact').length

  const by = <K extends string>(key: (r: LogEntry) => K): Map<K, Stat> => {
    const m = new Map<K, Stat>()
    for (const r of rows) {
      const s = m.get(key(r)) ?? stat()
      if (r.answers) s.calls++
      if (isDeny(r)) s.denies++
      if (r.verdict === 'flag') s.flags++
      s.cost += r.costUsd ?? 0
      m.set(key(r), s)
    }
    return m
  }
  const tools = [...by(what)].sort((a, b) => b[1].denies - a[1].denies || b[1].calls - a[1].calls)
  const days = by(r => day(r.ts))
  const span = Array.from({ length: DAYS }, (_, i) => day(opts.now - (DAYS - 1 - i) * 86_400_000))
  const peak = Math.max(1, ...span.map(d => days.get(d)?.calls ?? 0))
  const sessions = new Map<string, Stat & { first: number; last: number }>()
  for (const r of rows) {
    const s = sessions.get(r.session) ?? { ...stat(), first: r.ts, last: r.ts }
    s.first = Math.min(s.first, r.ts)
    s.last = Math.max(s.last, r.ts)
    if (r.answers) s.calls++
    if (isDeny(r)) s.denies++
    if (r.verdict === 'flag') s.flags++
    s.cost += r.costUsd ?? 0
    sessions.set(r.session, s)
  }
  const recentSessions = [...sessions].sort((a, b) => b[1].last - a[1].last).slice(0, 15)
  const recentDenies = denies.slice(-25).reverse()

  const tile = (n: string, label: string, kind = '') =>
    `<div class="feat"><span class="kind ${kind}">${esc(label)}</span><strong>${esc(n)}</strong></div>`
  const bars = span
    .map(d => {
      const s = days.get(d) ?? stat()
      const h = Math.max(s.calls ? 3 : 1, Math.round((s.calls / peak) * 100))
      const dh = s.calls ? Math.max(s.denies ? 3 : 0, Math.round((s.denies / peak) * 100)) : 0
      return `<div class="bar" title="${esc(d)}: ${s.calls} calls, ${s.denies} denies, ${money(s.cost)}"><i style="height:${h}%"></i><b style="height:${dh}%"></b></div>`
    })
    .join('')
  const toolRows = tools
    .map(([t, s]) => `<tr><td><code>${esc(t)}</code></td><td>${s.calls}</td><td class="${s.denies ? 'o' : ''}">${s.denies}</td><td>${s.flags}</td><td>${money(s.cost)}</td></tr>`)
    .join('')
  const sessionRows = recentSessions
    .map(([sid, s]) => `<tr${sid === opts.sid ? ' class="me"' : ''}><td><code>${esc(sid.slice(0, 8))}</code>${sid === opts.sid ? ' <span class="g">this</span>' : ''}</td><td>${when(s.last)}</td><td>${s.calls}</td><td class="${s.denies ? 'o' : ''}">${s.denies}</td><td>${money(s.cost)}</td></tr>`)
    .join('')
  const denyRows = recentDenies
    .map(r => `<tr><td>${when(r.ts)}</td><td><code>${esc(what(r))}</code></td><td>${esc(r.reason ?? '')}</td><td><code>${esc(r.session.slice(0, 8))}</code></td></tr>`)
    .join('')
  const lede = rows.length
    ? `${total.calls} Jev calls across ${sessions.size} sessions for ${money(total.cost)}. ${total.denies} ${total.denies === 1 ? 'deny' : 'denies'} (${pct(total.denies, total.calls + total.denies)}%), ${total.flags} injection ${total.flags === 1 ? 'flag' : 'flags'}, ${errors} ${errors === 1 ? 'error' : 'errors'}.`
    : 'No decisions logged yet. Run a few commands with ohmyjev on, then come back.'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ohmyjev · stats</title>
<style>
@font-face { font-family: "Champagne Limousines"; src: url("${FONTS}/ChampagneLimousines-Bold.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Departure Mono"; src: url("${FONTS}/DepartureMono-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Inter"; src: url("${FONTS}/Inter-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Inter"; src: url("${FONTS}/Inter-SemiBold.woff2") format("woff2"); font-weight: 600; font-display: swap; }
@font-face { font-family: "Inconsolata"; src: url("${FONTS}/Inconsolata-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
:root {
  --ground: #101315; --surface: #171c1f; --panel: rgba(16, 19, 21, .9); --panel-hi: rgba(26, 31, 34, .94);
  --paper: #cacccc; --muted: rgba(202, 204, 204, .78); --faint: rgba(202, 204, 204, .55);
  --line: rgba(121, 129, 134, .34); --steel: #798186; --warm: #c9c2b4; --orange: #de6145; --pink: #de4575; --green: #86a893;
  --ui: clamp(.8125rem, .75rem + .18vw, .9375rem);
  --logo: "Champagne Limousines", "Inter", system-ui, sans-serif; --display: "Inter", system-ui, sans-serif;
  --body: "Inconsolata", ui-monospace, Menlo, monospace; --label: "Departure Mono", ui-monospace, "SF Mono", Menlo, monospace;
  color-scheme: dark;
}
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { background: var(--ground); }
body {
  min-height: 100vh; padding: clamp(26px, 4.5vh, 64px) clamp(22px, 6vw, 120px) 80px; color: var(--paper); font-family: var(--body);
  -webkit-font-smoothing: antialiased; background: var(--ground);
  background-image: linear-gradient(rgba(121, 129, 134, .08) 1px, transparent 1px), linear-gradient(90deg, rgba(121, 129, 134, .08) 1px, transparent 1px);
  background-size: 64px 64px;
}
a { color: inherit; text-decoration: none; }
code { font-family: var(--body); color: var(--paper); }
.lbl { font-family: var(--label); font-size: var(--ui); letter-spacing: .08em; text-transform: uppercase; }
.header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: clamp(28px, 6vh, 64px); }
.brand { position: relative; font: 400 30px/1 var(--logo); letter-spacing: .04em; color: var(--paper); white-space: nowrap; }
.neon { position: absolute; inset: -.15em; padding: .15em; pointer-events: none; color: transparent; -webkit-text-stroke: max(.05em, 1.5px) transparent; background: linear-gradient(90deg, var(--orange), var(--pink)); -webkit-background-clip: text; background-clip: text; }
.header .lbl { color: var(--faint); }
.header .lbl span { color: var(--orange); }
.section-label { display: flex; align-items: center; gap: 10px; color: var(--paper); margin-bottom: 12px; }
.section-label::before { content: ""; width: 6px; height: 6px; background: var(--orange); }
.section-label span { margin-left: 8px; color: var(--faint); }
h2 { color: var(--paper); font: 600 clamp(2.4rem, 4.6vw, 4.4rem)/.95 var(--display); letter-spacing: -.05em; text-transform: lowercase; text-wrap: balance; }
h2 em { font-style: inherit; background: linear-gradient(90deg, var(--orange), var(--pink)); -webkit-background-clip: text; background-clip: text; color: transparent; padding-right: .04em; }
.lede { max-width: 62ch; color: var(--muted); font-size: clamp(1rem, .95rem + .2vw, 1.1875rem); line-height: 1.5; margin: 14px 0 clamp(22px, 4vh, 40px); }
h3 { font: var(--ui) var(--label); letter-spacing: .08em; text-transform: uppercase; color: var(--paper); }
section { margin-bottom: clamp(24px, 4vh, 44px); }
.grid { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); }
.grid > * { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: clamp(14px, 2vh, 22px) clamp(14px, 1.4vw, 22px); background: var(--panel); transition: background .25s ease; }
.grid > *:hover { background: var(--panel-hi); }
.tiles { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.g2 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
.kind { font: .6875rem var(--label); letter-spacing: .1em; text-transform: uppercase; color: var(--faint); display: inline-flex; align-items: center; gap: 6px; }
.kind::before { content: ""; width: 5px; height: 5px; background: var(--steel); }
.kind.gate::before { background: var(--orange); }
.kind.check::before { background: var(--green); }
.kind.route::before { background: #4575de; }
.feat strong { font: 600 clamp(1.6rem, 2.4vw, 2.2rem)/1.1 var(--display); letter-spacing: -.03em; color: var(--paper); font-variant-numeric: tabular-nums; }
.card-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
.card-head .meta { color: var(--faint); font: .6875rem var(--label); letter-spacing: .08em; text-transform: uppercase; }
.chart { display: flex; align-items: flex-end; gap: 3px; height: 160px; padding-top: 8px; border-bottom: 1px solid var(--line); }
.bar { position: relative; flex: 1; height: 100%; min-width: 0; }
.bar i, .bar b { position: absolute; left: 0; right: 0; bottom: 0; display: block; }
.bar i { background: rgba(134, 168, 147, .55); transition: background .2s ease; }
.bar b { background: var(--orange); }
.bar:hover i { background: var(--green); }
.axis { display: flex; justify-content: space-between; color: var(--faint); font: .6875rem var(--label); letter-spacing: .08em; padding-top: 6px; }
.legend { display: flex; gap: 18px; color: var(--faint); font: .6875rem var(--label); letter-spacing: .08em; text-transform: uppercase; }
.legend i { display: inline-block; width: 10px; height: 10px; vertical-align: -1px; margin-right: 6px; background: rgba(134, 168, 147, .55); }
.legend i.o { background: var(--orange); }
.tbl { overflow: auto; border: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; }
th { padding: 7px 14px; text-align: left; font: .6875rem var(--label); letter-spacing: .1em; text-transform: uppercase; color: var(--faint); border-bottom: 1px solid var(--line); background: var(--panel); white-space: nowrap; }
td { padding: 6px 14px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: .9375rem; line-height: 1.35; vertical-align: top; background: rgba(16, 19, 21, .82); font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
tr:hover td { background: var(--panel-hi); }
td:first-child, td:nth-child(2) { white-space: nowrap; }
td.o { color: var(--orange); }
.g { color: var(--green); }
.me td { background: rgba(134, 168, 147, .08); }
.empty { padding: 18px 14px; color: var(--faint); }
.foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--faint); font-size: .875rem; }
.foot a { color: var(--paper); }
.foot a span { color: var(--orange); }
</style></head>
<body>
<header class="header">
  <a class="brand" href="https://ohmyjev.xyz"><span class="neon" aria-hidden="true">ohmyjev</span>ohmyjev</a>
  <div class="lbl">stats <span>·</span> ${esc(when(opts.now))} UTC${opts.source ? ` <span>·</span> ${esc(opts.source)}` : ''}</div>
</header>
<p class="section-label lbl">What Jev decided <span>every session on this machine</span></p>
<h2>what jev <em>decided</em></h2>
<p class="lede">${esc(lede)}</p>

<section><div class="grid tiles">
  ${tile(String(total.calls), 'Jev calls')}
  ${tile(String(total.denies), 'denies', 'gate')}
  ${tile(String(total.flags), 'injection flags', 'check')}
  ${tile(money(total.cost), 'cost')}
  ${tile(`${quantile(ms, 0.5)} ms`, 'p50 latency')}
  ${tile(`${quantile(ms, 0.95)} ms`, 'p95 latency')}
  ${tile(String(sessions.size), 'sessions')}
  ${tile(String(errors), 'errors')}
  ${tile(String(compactions), 'auto-compactions', 'route')}
</div></section>

<section><div class="grid"><div>
  <div class="card-head"><h3>last ${DAYS} days</h3><span class="legend"><span><i></i>calls</span><span><i class="o"></i>denies</span></span></div>
  <div class="chart">${bars}</div>
  <div class="axis"><span>${esc(span[0])}</span><span>${esc(span.at(-1))}</span></div>
</div></div></section>

<section><div class="grid g2">
  <div>
    <div class="card-head"><h3>by tool</h3><span class="meta">most denied first</span></div>
    <div class="tbl">${toolRows ? `<table><thead><tr><th>tool</th><th>calls</th><th>denies</th><th>flags</th><th>cost</th></tr></thead><tbody>${toolRows}</tbody></table>` : '<p class="empty">nothing yet</p>'}</div>
  </div>
  <div>
    <div class="card-head"><h3>sessions</h3><span class="meta">latest ${recentSessions.length} of ${sessions.size}</span></div>
    <div class="tbl">${sessionRows ? `<table><thead><tr><th>session</th><th>last seen (UTC)</th><th>calls</th><th>denies</th><th>cost</th></tr></thead><tbody>${sessionRows}</tbody></table>` : '<p class="empty">nothing yet</p>'}</div>
  </div>
</div></section>

<section><div class="grid"><div>
  <div class="card-head"><h3>recent denies</h3><span class="meta">latest ${recentDenies.length} of ${denies.length}</span></div>
  <div class="tbl">${denyRows ? `<table><thead><tr><th>when (UTC)</th><th>tool</th><th>reason</th><th>session</th></tr></thead><tbody>${denyRows}</tbody></table>` : '<p class="empty">no denies</p>'}</div>
</div></div></section>

<footer class="foot">
  <span>Read from ~/.ohmyjev/log, readable only by you. Nothing on this page leaves the machine.</span>
  <span>Regenerate with <code>/omj stats</code> · <a href="https://ohmyjev.xyz">ohmyjev<span>.</span>xyz</a></span>
</footer>
</body></html>
`
}
