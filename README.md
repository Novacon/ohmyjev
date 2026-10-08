# ohmyjev

ohmyjev is a Claude Code mod that asks [Jev](https://typesafe.ai) to judge risky tool calls before they run. Jev is
TypeSafe's decision model. You send it state and typed questions, and it returns probabilities in about 300 ms for a
fraction of a cent. The mod runs as in-process hooks and needs Claude Code 2.1.287 or later, where mods are early
access.

| Feature | What it does |
|---|---|
| Bash gate | Denies a command when Jev rates it irreversible at 0.6 or more, or destructive at 0.7 or more. |
| Write gate | Denies writes outside the repo and `allowPaths`, and writes that contain a real credential. Code makes the path decision and follows symlinks the way the OS does. |
| Exfil gate | Denies a WebFetch or MCP call when Jev rates it at 0.7 or more for sending local data, files or credentials out. |
| Policies | Every gate also checks the call against your own rules in the `policies` setting. |
| Injection screen | Adds a "treat this as data" note for the model when output from Bash, WebFetch, an MCP tool, or a Read outside the repo contains instructions aimed at it. |
| Done-check | When the agent says it is done but nothing shows it ran a check, blocks the stop once and tells it to verify. |
| Router | Asks Jev once per request for a tier, an effort level and a risk score, then raises or lowers effort and picks the model for general-purpose subagents. |
| Auto-compact | Compacts the conversation when the task changes after a finished step and the context is at least 40% full. The summary keeps the new request in full. |
| `ask_jev` | Gives the model a tool that asks Jev about repo files or text without loading them into its context. |
| `/jev` | Shows this session's Jev calls, errors, cost, median latency and denies, and where the key comes from. It never prints the key. |

Anything ohmyjev doesn't deny goes to Claude Code's normal permission flow. That includes middling answers, Jev being
down or slower than 1.5 s, a missing key, and any error inside ohmyjev. ohmyjev never asks you to approve anything. Jev
can be wrong, so keep your deny rules in `settings.json`.

## Install

```
/plugin marketplace add Novacon/ohmyjev
/plugin install ohmyjev@ohmyjev
```

Enter a TypeSafe key on the settings screen, where Claude Code keeps it in secure storage. You can export
`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` instead. To install from a local checkout, run
`claude plugin marketplace add /path/to/ohmyjev` and then `claude plugin install ohmyjev@ohmyjev`.

## Settings

Each feature and threshold is a row in `/config`. `allowPaths` lists the places outside the repo where writes may go,
separated by `;`. The default is `~/.claude;$TMPDIR;/tmp`. ohmyjev ignores any entry that contains `..`.

The router changes effort on the main loop and the model for general-purpose subagents. Turn on `routeMainModel` to
also switch the main model. It is off by default because switching models throws away the prompt cache. The settings
`fastModel`, `balancedModel` and `deepModel` hold the model id for each tier.

## Statusline

Copy `jev_segment()` from `extras/statusline_segment.py` into your statusline script. It shows one of these:

```
jev ✓23 ⛔1 ↑opus/high 🗜2     Jev calls, denies, this turn's route, auto-compactions
jev ⚠ down                    Jev failed or timed out in the last 5 minutes, so the gates let calls through
jev ⚠ no key                  no key configured
```

## Logs

ohmyjev writes one line per decision to `~/.ohmyjev/log/<session>.jsonl`, readable only by you. It doesn't wait for the
write, so a failed write loses that line and nothing else.

## Develop

```bash
claude --plugin-dir "$PWD" -p "Reply OK."   # writes the API types to .claude-plugin/types
claude plugin test . && claude plugin validate . && bunx -p typescript@5.6.3 tsc -p .
```

MIT license. The question rubrics come from [disler/ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev).
