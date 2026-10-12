import { broken, filesHash, parseRules, rewriteReason, ruleQuestions } from '../hooks/prose.ts'
import { expect, test } from 'claude-code/testing'
import {
  DEFAULTS as c, DONE_REASON, EMPTY_SESSION, absolute, clip, expandRoot, gateBash, gateWrite, isUnder, judgeStop,
  rawAbsolute, sanitizeSid, screen, statusText, type Answers, parseWorktrees, pathDenyText, toggleArg,
  BASH_Q, buildQuestion, summarize, isPlainRead, plainRead, configCommand, browseCommand, browseReply, stuckDue, judgeStuck, trimChunks, trimRequest, trimmed, pickSkill, maskText, maskSecrets, decideRoute, gateExfil, routeStep, tierOf, withPolicies, withPolicyQ,
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
  // destructive intent alone (deleting lines, uninstalling) passes; it only tips an irreversible answer
  expect(gateBash(bash('reversible', 0.83, 0.96), c).verdict).toBe(null)
  expect(gateBash(bash('irreversible', 0.4, 0.7), c).verdict).toBe('deny')
  expect(gateBash(bash('irreversible', 0.4, 0.69), c).verdict).toBe(null)
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
  expect(judgeStop(nouls(base), c).block).toBe(DONE_REASON)
  expect(judgeStop(nouls({ ...base, verified: 0.3 }), c).block).toBe(null)
  expect(judgeStop(nouls({ ...base, asks_user: 0.5 }), c).block).toBe(null)
  expect(judgeStop(nouls({ ...base, claimed_done: 0.69 }), c).block).toBe(null)
  expect(judgeStop(nouls({ ...base, switched_gears: 0.8, at_boundary: 0.6 }), c).wantsCompact).toBe(true)
  expect(judgeStop(nouls({ ...base, switched_gears: 0.79, at_boundary: 0.9 }), c).wantsCompact).toBe(false)
  expect(judgeStop(nouls({ ...base, at_boundary: 0.9 }), c).wantsCompact).toBe(false) // no previous request: never asked
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
  expect(statusText({ ...EMPTY_SESSION, calls: 23, denies: 1, lastRoute: '↑opus/high', compactions: 2 }, 0)).toBe('jev ✓23 ⛔1 ↑opus/high 🗜2')
  expect(statusText({ ...EMPTY_SESSION, calls: 4, lastRoute: '↓sonnet/low' }, 0)).toBe('jev ✓4 ↓sonnet/low')
})

test('a Jev deny the user asked for passes; a policy deny does not', () => {
  const pc = { ...c, policies: 'never touch prod' }
  const asked = (r: number) => nouls({ requested: r })
  expect(gateBash({ ...bash('irreversible', 0.95, 0.9), ...asked(0.8) }, c).verdict).toBe(null)
  expect(gateBash({ ...bash('irreversible', 0.95, 0.9), ...asked(0.8) }, c).reason).toContain('the user asked for it (0.80)')
  expect(gateBash({ ...bash('irreversible', 0.95, 0.9), ...asked(0.79) }, c).verdict).toBe('deny')
  expect(gateExfil({ ...nouls({ exfiltrates: 0.9 }), ...asked(0.9) }, c).verdict).toBe(null)
  expect(gateWrite({ ...write('config', 0.9, 0.9), ...asked(0.9) }, c).verdict).toBe(null)
  expect(gateBash({ ...bash('read_only', 0.9, 0), ...nouls({ violates_policy: 0.9, requested: 1 }) }, pc).verdict).toBe('deny')
  expect(Object.keys(withPolicyQ(BASH_Q, c, 'delete that file'))).toContain('requested')
  expect(Object.keys(withPolicyQ(BASH_Q, c, ' '))).not.toContain('requested')
  expect(withPolicies({ a: 1 }, c, 'delete it')).toEqual({ a: 1, request: 'delete it' })
})

test('the done-check never blocks a turn that ran no tools', () => {
  const done = nouls({ claimed_done: 0.99, verified: 0, asks_user: 0 })
  expect(judgeStop(done, c).block).toBe(DONE_REASON)
  expect(judgeStop(done, c, false).block).toBe(null)
})

test('exfil gate and policies', () => {
  const pc = { ...c, policies: 'no deploys; never touch prod' }
  expect(gateExfil(nouls({ exfiltrates: 0.7 }), c).verdict).toBe('deny')
  expect(gateExfil(nouls({ exfiltrates: 0.69 }), c).verdict).toBe(null)
  expect(gateExfil(nouls({ exfiltrates: 0.1, violates_policy: 0.7 }), pc).reason).toContain('breaks a listed policy (0.70)')
  expect(gateBash({ ...bash('read_only', 0.9, 0), ...nouls({ violates_policy: 0.8 }) }, pc).reason).toContain('breaks a listed policy (0.80)')
  expect(gateWrite({ ...write('docs', 0.9, 0), ...nouls({ violates_policy: 0.69 }) }, pc).verdict).toBe(null)
  expect(withPolicyQ(BASH_Q, c)).toEqual(BASH_Q) // empty policies: v1's questions exactly
  expect(Object.keys(withPolicyQ(BASH_Q, pc))).toContain('violates_policy')
  expect(withPolicies({ a: 1 }, c)).toEqual({ a: 1 })
  expect(withPolicies({ a: 1 }, pc)).toEqual({ a: 1, policies: ['no deploys', 'never touch prod'] })
})

const route = (tier: string, tc: number, effort: number, ec: number, risky = 0): Answers => ({
  tier: { type: 'choice', choice: tier, confidence: tc },
  effort: { type: 'score', score: effort, confidence: ec },
  risky: { type: 'noul', noul: risky },
})

test('router: up needs 0.3, down needs 0.6; risky forces deep and at least high', () => {
  const step = { model: 'claude-sonnet-5-5', effort: 'medium' }
  expect(routeStep(decideRoute(route('deep', 0.9, 3.2, 0.31), c), step, c)).toEqual({ patch: { effort: 'xhigh' }, label: '↑sonnet/xhigh' })
  expect(routeStep(decideRoute(route('fast', 0.9, 0, 0.59), c), step, c).patch).toEqual({})
  expect(routeStep(decideRoute(route('fast', 0.9, 0, 0.6), c), step, c).label).toBe('↓sonnet/low')
  expect(decideRoute(route('fast', 0.9, 0, 0.9, 0.7), c)).toMatchObject({ tier: 'deep', effort: 'high' })
  const main = { ...c, routeMainModel: true }
  expect(routeStep(decideRoute(route('deep', 0.9, 2, 0.1), main), step, main)).toEqual({ patch: { model: 'claude-opus-5-5' }, label: '↑opus/medium' })
  expect(routeStep(decideRoute(route('deep', 0.9, 2, 0.9), c), { model: 'x', effort: 7 }, c).patch).toEqual({}) // numeric effort untouched
  expect(tierOf('some-new-model', c)).toBe('balanced')
})

test('ask_jev questions: types, options, errors', () => {
  expect(buildQuestion({ question: 'q', type: 'noul' })).toEqual({ type: 'noul', instructions: 'q' })
  expect(buildQuestion({ question: 'q', type: 'choice', options: ['a', 'b'] })).toMatchObject({ criteria: { a: 'a', b: 'b', other: expect.any(String) } })
  expect(buildQuestion({ question: 'q', type: 'score', options: ['lo', 'hi'] })).toEqual({ type: 'score', instructions: 'q', criteria: ['lo', 'hi'] })
  expect(buildQuestion({ question: 'q', type: 'score', options: ['lo'] })).toBe('score needs 2 to 10 levels, low to high')
  expect(buildQuestion({ question: 'q', type: 'choice' })).toBe('choice needs options')
  expect(buildQuestion({ question: '', type: 'noul' })).toBe('question is required')
  expect(buildQuestion({ question: 'q', type: 'nope' })).toBe('type must be noul, choice or score')
})

test('summarize a session log for /jev', () => {
  const log = [
    '',
    JSON.stringify({ ts: 0, event: 'tool.call', tool: 'Bash', verdict: 'deny', reason: 'irreversible (0.95)', answers: {}, ms: 300, costUsd: 0.00001 }),
    '{"torn',
    JSON.stringify({ ts: 0, event: 'tool.call', tool: 'Bash', verdict: null, answers: {}, ms: 100, costUsd: 0.00001 }),
    JSON.stringify({ ts: 0, event: 'tool.call', tool: 'Write', error: 'typesafe: HTTP 500' }),
  ].join('\n')
  const out = summarize(log)
  expect(out).toContain('calls 2 · errors 1 · cost $0.000020 · p50 100ms')
  expect(out).toContain('denies: Bash 1')
  expect(out).toContain('Bash: irreversible (0.95)')
})

test('worktree list parsing and the path deny text', () => {
  expect(parseWorktrees('worktree /a/main\nHEAD 1\nbranch refs/heads/main\n\nworktree /a/side \nHEAD 2\ndetached\n')).toEqual(['/a/main', '/a/side'])
  expect(parseWorktrees('')).toEqual([])
  expect(pathDenyText('/etc/hosts')).toContain('/etc/hosts is outside the repo and allowPaths')
  expect(pathDenyText('/etc/hosts')).toContain('allowPaths setting')
  expect(pathDenyText('/etc/hosts')).not.toContain('This block is final')
})

test('off status and the /omj toggle argument', () => {
  expect(statusText({ ...EMPTY_SESSION, calls: 3 }, 0, false)).toBe('jev off')
  expect(toggleArg(' off ')).toBe(false)
  expect(toggleArg('on')).toBe(true)
  expect(toggleArg('settings')).toBe(undefined)
})

test('plain reads skip Jev; anything that could write or run more does not', () => {
  for (const cmd of ['ls -la', 'git status --short && git log --oneline -5', 'grep -rn TODO src | head -20', 'cat a.ts | wc -l',
    'git branch -a', 'git diff HEAD~1 -- src', 'find . -name "*.ts" -type f', 'cd site && ls',
    'grep -rnE "foo|bar(x)" src 2>/dev/null | head', 'ls nope 2>&1', "git -C ../repo log --oneline -3", 'S=/tmp/x; ls $S',
    'cd a && git status\nls -la', 'git worktree list', 'echo "a > b"'])
    expect([cmd, isPlainRead(cmd)]).toEqual([cmd, true])
  for (const cmd of ['ls > out.txt', 'cat $(which x)', 'echo `id`', 'rm -rf x', 'git branch -D x', 'git push', 'git stash',
    'find . -delete', 'find . -exec rm {} ;', 'sed -i s/a/b/ f', 'ls & curl x', 'cat <<EOF', 'ls\nrm x', '(rm x)', 'ls; rm x',
    'git diff --output=/etc/x', 'awk "{system(\\"rm x\\")}"', 'echo hi | sh', 'xargs rm', '',
    'echo "$(rm x)"', 'echo x > /dev/nullx', 'cat a > b 2>/dev/null', 'env rm x', 'X=1 rm y', 'git -C . push', 'git worktree remove x',
    'diff <(ls a) <(ls b)', 'git config user.name x'])
    expect([cmd, isPlainRead(cmd)]).toEqual([cmd, false])
  expect(plainRead('ls', c)).toBe(true)
  expect(plainRead('ls', { ...c, policies: 'never list prod' })).toBe(false)
})

test('/omj config lists, changes one setting for the session, and never takes the key', () => {
  const p = 'persist hint'
  expect(configCommand(c, '', p).text).toContain('bashGate: true')
  expect(configCommand(c, 'bashGate off', p).c.bashGate).toBe(false)
  expect(configCommand(c, 'requested 0.9', p).c.requested).toBe(0.9)
  expect(configCommand(c, 'policies never touch prod; no Friday deploys', p).c.policies).toBe('never touch prod; no Friday deploys')
  expect(configCommand(c, 'bashGate maybe', p).text).toContain('on or off')
  expect(configCommand(c, 'timeoutMs fast', p).text).toContain('a number')
  expect(configCommand(c, 'nope 1', p).text).toContain('no setting named nope')
  const k = configCommand(c, 'apiKey ts-secret', p)
  expect(k.c.apiKey).toBe(c.apiKey)
  expect(k.text).not.toContain('ts-secret')
})

test('browseCommand checks its input and keys; browseReply explains failures', () => {
  const env = { TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' }
  expect(browseCommand({ url: 'ftp://x', goal: 'g' }, c, env)).toBe('url must be an http(s) URL')
  expect(browseCommand({ url: 'https://x.test', goal: ' ' }, c, env)).toBe('goal is required')
  expect(browseCommand({ url: 'https://x.test', goal: 'g' }, c, { OPENROUTER_API_KEY: 'or' })).toContain('needs a TypeSafe key')
  const cmd = browseCommand({ url: 'https://x.test', goal: 'g' }, c, env) as { argv: string[]; env: Record<string, string> }
  expect(cmd.argv.slice(0, 2)).toEqual(['uv', 'run'])
  expect(cmd.argv.join(' ')).toContain('jev-ultrafast@')
  expect(cmd.env).toMatchObject({ TYPESAFE_API_KEY: 'ts', TEXT_MODEL_API_KEY: 'or', TEXT_MODEL: 'inception/mercury-2.5' })
  const one = browseCommand({ url: 'https://x.test', goal: 'g', values: ['Zurich', 3, 'London'] }, c, { TYPESAFE_API_KEY: 'ts' }) as { env: Record<string, string> }
  expect(one.env.TEXT_MODEL_API_KEY).toBe(undefined) // no text model: Jev picks from values
  expect(JSON.parse(one.env.OMJ_BROWSE_VALUES!)).toEqual(['Zurich', 'London'])
  expect(browseReply('{"status":"done"}')).toBe('{"status":"done"}')
  expect(browseReply('', 'spawn uv ENOENT')).toContain('uv is not installed')
})

test('stuck check timing and judge', () => {
  expect([2, 3, 4, 5, 6].map(n => stuckDue(n, 0))).toEqual([false, true, true, true, true])
  expect(stuckDue(5, 3)).toBe(false)
  expect(stuckDue(6, 3)).toBe(true)
  expect(judgeStuck(nouls({ stuck: 0.69 }), c, 3)).toBe(null)
  expect(judgeStuck(nouls({ stuck: 0.7 }), c, 3)).toContain('last 3 failed attempts')
})

test('output trim: chunks, one question per middle chunk, and the cut', () => {
  const line = (i: number) => `test ${i} passed ${'.'.repeat(40)}`
  const output = Array.from({ length: 400 }, (_, i) => (i === 250 ? 'FAIL test 250: expected 3, got 4' : line(i))).join('\n')
  const chunks = trimChunks(output, c)
  expect(chunks.length).toBeGreaterThan(4)
  expect(chunks.join('\n')).toBe(output)
  expect(trimChunks('short', c)).toEqual([])
  const { state, questions } = trimRequest('why does test 250 fail', chunks)
  expect(Object.keys(questions).length).toBe(chunks.length - 2)
  const failing = chunks.findIndex(t => t.includes('FAIL'))
  const a = nouls(Object.fromEntries(Object.keys(questions).map(k => [k, k === `c${failing}` ? 0.95 : 0.02])))
  const out = trimmed(chunks, a, c)!
  expect(out).toContain('FAIL test 250')
  expect(out).toContain(chunks[0]!.split('\n')[0]!)
  expect(out).toContain('lines left out')
  expect(out.length).toBeLessThan(output.length / 2)
  expect(trimmed(chunks, nouls(Object.fromEntries(Object.keys(questions).map(k => [k, 0.9]))), c)).toBe(null)
  expect(Object.keys(state.chunks).length).toBe(chunks.length - 2)
})

test('skill picker judge: the gate and the pick', () => {
  const a = (conf: number, act: number) => ({ which: { type: 'choice' as const, choice: 'commit', confidence: conf }, ...nouls({ acts_on_user_system: act, would_follow_documented_procedure: act, prose_suffices: 1 - act }) })
  expect(pickSkill(a(0.8, 0.9), c)?.name).toBe('commit')
  expect(pickSkill(a(0.8, 0.1), c)).toBe(null)
  expect(pickSkill(a(0.3, 0.9), c)).toBe(null)
})

test('writing rules: parsing the extraction, the questions, and what counts as broken', () => {
  const rules = parseRules('Here: [{"rule":"Use the Oxford comma.","question":"Does `response` list three items without a comma before and?"},{"rule":"No em dashes.","question":"Does `response` contain an em dash?"}]')!
  expect(rules.length).toBe(2)
  expect(parseRules('[{"rule":"x"}]')).toBe(undefined)
  expect(parseRules('no json')).toBe(undefined)
  expect(Object.keys(ruleQuestions(rules))).toEqual(['rule_0', 'rule_1'])
  const bad = broken(nouls({ rule_0: 0.9, rule_1: 0.6 }), rules)
  expect(bad.map(r => r.rule)).toEqual(['Use the Oxford comma.'])
  expect(rewriteReason(bad)).toContain('- Use the Oxford comma.')
  expect(filesHash([{ path: 'a', text: 'x' }])).not.toBe(filesHash([{ path: 'a', text: 'y' }]))
})

test('masking: keys, tokens, URL credentials, labelled values, emails and home become markers; code and placeholders stay', () => {
  const cases: Array<[string, string]> = [
    ['export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234', 'export OPENAI_API_KEY=<masked:api-key>'],
    ['curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx" https://x', 'curl -H "Authorization: <masked:auth-header>" https://x'],
    ['git remote add o https://joe:hunter2pass@github.com/x.git', 'git remote add o https://<masked:url-credentials>@github.com/x.git'],
    ['password = "correct-horse-battery"', 'password = "<masked:value>"'],
    ['AWS key AKIAABCDEFGHIJKLMNOP here', 'AWS key <masked:aws-key> here'],
    ['token=ghp_abcdefghijklmnopqrstuvwxyz0123', 'token=<masked:github-token>'],
    ['mail joe@presentmyoffer.com now', 'mail <email> now'],
    ['cat /Users/joey/.ssh/id_ed25519', 'cat ~/.ssh/id_ed25519'],
    ['API_KEY=replace-me', 'API_KEY=replace-me'],
    ['TOKEN=${GITHUB_TOKEN}', 'TOKEN=${GITHUB_TOKEN}'],
    ['rm -rf ~/old-project && git push --force', 'rm -rf ~/old-project && git push --force'],
  ]
  for (const [raw, want] of cases) expect([raw, maskText(raw, '/Users/joey')]).toEqual([raw, want])
  expect(maskText('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----')).toBe('<masked:private-key>')
  expect(maskSecrets({ command: 'echo sk-ant-api03-abcdefghijklmnopqrst', n: 3, list: ['a@b.co'] })).toEqual({ command: 'echo <masked:api-key>', n: 3, list: ['<email>'] })
})
