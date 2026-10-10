# Bridged pi tools got the exfil gate instead of their own

**Reported:** a user-approved `git push -q origin main && git push -q cpanel main` (own GitHub repo, own cPanel host),
run from a Claude Code session in `~/Documents/kilobit.setup`, was denied: "sends local data out (0.90)". The local
commits chained after it in the same command were blocked with it.

**Root cause:** the session ran under pi-claude-bridge, so every tool was pi's, bridged in over MCP as
`mcp__custom-tools__bash|read|write|edit` (decision log `~/.ohmyjev/log/5b95d965-….jsonl`: 77 bridged bash calls, no
native `Bash`). `hooks/ohmyjev.ts` sends every `mcp__*` call to the exfil gate, so:
- every bridged bash command was asked only "does this send local data out?": a push to a remote says yes (the false
  positive), while `rm -rf` never met the irreversible/destructive rubric (the deny that was not enforced);
- bridged writes and edits skipped the allowPaths check and the credential check (pi spells the path `path`, not
  `file_path`, and pi's `@`/`file://` spellings were not resolved).

**Fix:** `kindOf` maps `mcp__custom-tools__{bash,read,write,edit}` to `Bash`/`Read`/`Write`/`Edit`, and those calls get
the native gate and screen. `pathOf` reads `path` too, through `hostPath` (moved to `hooks/policy.ts` and shared with the
adapters); `edits` is the content of a pi edit. Other `mcp__*` tools keep the exfil gate. Tests: `tests/hooks.test.ts`,
the four "bridged" cases.
