# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who run coding agents (Claude Code, Codex, pi, omp), often unattended or in bypass mode across several projects and worktrees. Their job: let the agent work fast without babysitting permission prompts, and without it wrecking anything that can't be undone.

## Product Purpose

ohmyjev puts Jev, TypeSafe's decision model, in front of every step a coding agent takes. Jev answers typed questions in about 160 ms for about $0.00003, cheap enough to ask about every call. ohmyjev uses those answers to make the agent faster (no prompt for safe commands, long output cut to what matters, the right skill loaded, the right model picked, a browser driven by Jev instead of the big model) and safer (irreversible or data-leaking commands stopped until the user says yes). Success: the agent finishes sooner and cheaper, and nothing irreversible happens that the user didn't ask for.

## Positioning

Jev, batteries included: one install across four agent hosts. A per-call judgment from a fast decision model, not rules and not the big model second-guessing itself. It removes prompts rather than adding them.

## Operating Context

Installed as a Claude Code plugin, a Codex plugin, and a pi/omp extension (npm `ohmyjev`). Configured with `/omj config`, `/plugin configure`, or each host's settings. Needs a TypeSafe key (or OpenRouter). Logs stay in `~/.ohmyjev`. `/omj stats` opens a local dashboard.

## Capabilities and Constraints

Faster: auto-approve, plain-read fast path, output trim, skill picker (Claude Code only), stuck check, model router, auto-compact, `browse` (jev-ultrafast, off by default).
Safer: bash gate, write gate, exfil gate, policies, request-aware unblock ("say yes"), injection screen, done-check.
Tools: `ask_jev`, `/omj`, `/omj config`, `/omj stats`, `/omj on|off`.
Codex hooks can't add tools or commands; pi and omp never ask permission, so auto-approve has nothing to answer there.

## Brand Commitments

Name `ohmyjev` (lowercase). Logo: script "ohmy" in white with block "jev" in purple (`site/logo.webp`, `docs/logo.png`, light variant `docs/logo-light.png`). Palette set by the owner: brand #9d78ff, brand-hi and lavender #b69cff, link #c9b8ff, paper #f5f3fa, muted #b3aec2, faint #91899f, ok #56e887, warn #ffc857, err #ff737d, info #74c7ff, on a near-black ground. Voice: plain, specific, numbers over adjectives (the unslop rules).

## Evidence on Hand

All measured on the owner's Mac, 2026-10-10/11:
- Google Flights one-way Zurich to London, Claude Code end to end, 3 runs each, all correct (medians): default Opus 5.5 xhigh + Playwright 108 s, $0.23-0.42; router picking Haiku + Playwright 44 s, ~$0.01; router + `browse` 18 s, ~$0.002; `browse` called directly 10 s.
- Auto-approve: 637 of 865 Jev-judged shell commands in real logs (74%) clear its bar; plain reads (31% of 4,888 real commands) skip Jev entirely.
- Jev cost and speed: 3,877 real calls over 90 sessions, $0.13 total ($0.000034 each), median 163 ms, p95 239 ms.
- Trim: a 20,471-character test log to 4,582 with the failure kept, 281 ms.
- Gates: 28 of 28 live cases (`tests/live.ts`), three times.
- Router on 10 coding tasks: 10/10 both ways, ~15% faster, 6% cheaper (weak; keep off the landing page).
- Stuck check 0.96 on repeats vs 0.15 on unrelated failures; skill picker 4/4 on 8 real skills; 8 of 12 old denies were reversible (fixed).
No testimonials, user counts, stars, or customer logos exist. Do not invent them.

## Product Principles

- Remove friction, never add it: no new prompts; fail open.
- Every claim is a measurement with its setup stated.
- Cheap judgment everywhere beats expensive judgment rarely.
- The user's own words outrank the model: say yes and it runs.
