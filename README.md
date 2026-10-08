# ohmyjev

ohmyjev is a Claude Code mod that checks risky tool calls with [Jev](https://typesafe.ai) before they run. Jev is
TypeSafe's decision model. You send it some state and a few typed questions, and it sends back probabilities in about
300 ms for a fraction of a cent. That's fast and cheap enough to ask about every command your agent runs. The mod runs
as in-process hooks, so you need Claude Code 2.1.287 or later (mods are still early access).

| Feature | What it does |
|---|---|
| Bash gate | Denies a command when Jev rates it irreversible at 0.6 or more, or destructive at 0.7 or more. |
| Write gate | Denies writes outside the repo and `allowPaths`, and writes that contain a real credential. The path check is plain code, not Jev, and it follows symlinks the same way the OS does. |
| Exfil gate | Denies a WebFetch or MCP call when Jev rates it 0.7 or more for sending your local data, files or credentials out. |
| Policies | Every gate also checks the call against your own rules in the `policies` setting. |
| Injection screen | When output from Bash, WebFetch, an MCP tool, or a Read outside the repo has instructions aimed at the model, it adds a note telling the model to treat that output as data. |
| Done-check | If the agent says it's done but nothing shows it ran a check, it blocks the stop once and tells the agent to verify. |
| Router | Asks Jev once per request for a tier, an effort level and a risk score. Then it raises or lowers effort and picks the model for general-purpose subagents. |
| Auto-compact | When the task changes after a finished step and the context is at least 40% full, it compacts the conversation. The summary keeps the new request in full. |
| `ask_jev` | A tool the model can use to ask Jev about repo files or text without loading them into its own context. |
| `/jev` | Shows this session's Jev calls, errors, cost, median latency and denies, plus where the key comes from. It never prints the key itself. |

Anything ohmyjev doesn't deny just goes on to Claude Code's normal permission flow. That covers middling answers, Jev
being down or slower than 1.5 s, a missing key, and any error inside ohmyjev. It never stops to ask you to approve
anything. Jev can be wrong though, so keep your deny rules in `settings.json`.

## Install

```
/plugin marketplace add Novacon/ohmyjev
/plugin install ohmyjev@ohmyjev
```

Then enter your TypeSafe key on the settings screen, and Claude Code keeps it in secure storage. You can also just
export `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. If you're installing from a local checkout, run
`claude plugin marketplace add /path/to/ohmyjev` and then `claude plugin install ohmyjev@ohmyjev`.

## Settings

Every feature and threshold has its own row in `/config`. `allowPaths` is the list of places outside the repo where
writes are allowed, separated by `;`. The default is `~/.claude;$TMPDIR;/tmp`, and ohmyjev ignores any entry with `..`
in it.

The router changes effort on the main loop and the model for general-purpose subagents. If you want it to switch the
main model too, turn on `routeMainModel`. It's off by default because switching models throws away the prompt cache.
`fastModel`, `balancedModel` and `deepModel` hold the model id for each tier.

## Statusline

Copy `jev_segment()` from `extras/statusline_segment.py` into your statusline script. It shows one of these:

```
jev ✓23 ⛔1 ↑opus/high 🗜2     Jev calls, denies, this turn's route, auto-compactions
jev ⚠ down                    Jev failed or timed out in the last 5 minutes, so the gates let calls through
jev ⚠ no key                  no key configured
```

## Logs

Every decision gets one line in `~/.ohmyjev/log/<session>.jsonl`, and only you can read it. ohmyjev doesn't wait on
that write, so if one fails you lose that line and nothing else.

## Develop

```bash
claude --plugin-dir "$PWD" -p "Reply OK."   # writes the API types to .claude-plugin/types
claude plugin test . && claude plugin validate . && bunx -p typescript@5.6.3 tsc -p .
```

MIT license. The question rubrics come from [disler/ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev).
