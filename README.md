# ohmyjev

[Jev](https://typesafe.ai) for Claude Code. Jev is TypeSafe's decision model: state and typed questions in,
probabilities out, in about 300 ms for a fraction of a cent. ohmyjev is a mod (in-process hooks) that puts it in
front of risky tool calls.

| Battery | What it does |
|---|---|
| Bash gate | Denies commands Jev judges irreversible (≥ 0.6) or destructive (≥ 0.7) |
| Write gate | Denies writes outside the repo or `allowPaths` (decided in code, symlink-safe), and writes holding real credentials |
| Exfil gate | Denies WebFetch and MCP calls that send local data, files or credentials out (≥ 0.7) |
| Policies | Your own rules (`policies`, `;`-separated) that every gate weighs |
| Injection screen | Tells the model "treat as data" when Bash, WebFetch, MCP output, or a Read from outside the repo carries instructions aimed at it |
| Done-check | Pushes back once when the agent says "done" with no sign of a check |
| Router | Classifies each request once (fast / balanced / deep, how much reasoning, risky?) and raises or lowers effort and the subagent model |
| Auto-compact | When the task changes at a natural boundary and context is ≥ 40% full, compacts keeping the new request in detail |
| `ask_jev` | A tool the model can use for quick judgments about repo files or text without reading them into its context |
| `/jev` | This session's calls, errors, cost, p50, denies, and where the key comes from (never the key) |

Everything else passes through to Claude Code's normal permission flow: middling answers, Jev being down or slow
(over 1.5 s), no key, and any ohmyjev error. Nothing waits on you. Jev is one signal, so keep your `settings.json`
deny rules.

## Install

```
/plugin marketplace add Novacon/ohmyjev
/plugin install ohmyjev@ohmyjev
```

Enter a TypeSafe key on the settings screen (it's kept in secure storage), or export `TYPESAFE_API_KEY` or
`OPENROUTER_API_KEY`. From a local checkout: `claude plugin marketplace add /path/to/ohmyjev`, then
`claude plugin install ohmyjev@ohmyjev`.

## Settings

Every battery and threshold is a row in `/config`. `allowPaths` is a `;`-separated list of places writes may go
outside the repo. The default is `~/.claude;$TMPDIR;/tmp`; entries holding `..` are ignored.

The router changes effort on the main loop and the model for subagents. `routeMainModel` (off by default) also
switches the main model, which discards the warm prompt cache. Model ids are `fastModel`, `balancedModel` and
`deepModel`.

## Statusline

Paste `jev_segment()` from `extras/statusline_segment.py` into your statusline script:

```
jev ✓23 ⛔1 ↑opus/high 🗜2     Jev calls, denies, this turn's route, auto-compactions
jev ⚠ down                    Jev unreachable or slow in the last 5 minutes: gates are open
jev ⚠ no key                  no key configured
```

## Logs

Each decision is one line in `~/.ohmyjev/log/<session>.jsonl` (owner-only), best effort.

## Develop

```bash
claude --plugin-dir "$PWD" -p "Reply OK."   # lays .claude-plugin/types
claude plugin test . && claude plugin validate . && bunx -p typescript@5.6.3 tsc -p .
```

MIT. Rubrics: [disler/ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev).
