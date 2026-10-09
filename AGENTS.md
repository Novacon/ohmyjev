# ohmyjev: notes for coding agents

## Layout
- `hooks/policy.ts`, `hooks/jev.ts`: pure decision logic, shared by every agent version.
- `hooks/ohmyjev.ts`: the Claude Code plugin (`.claude-plugin/plugin.json`, `/plugin install ohmyjev --marketplace Novacon/ohmyjev`).
- `adapters/shared.ts`, `adapters/omp.ts`, `adapters/pi.ts`: the omp and pi extensions, published to npm as `ohmyjev` (`package.json`).
- `site/`: ohmyjev.xyz. GitHub Pages deploys it on every push to `main` that touches `site/`.

## Checks
```bash
bun install
bun test adapters && claude plugin test .
./node_modules/.bin/tsc -p tsconfig.adapters.json && bunx -p typescript@5.6.3 tsc -p .
claude plugin validate .
```

## Release (npm and the Claude plugin)
1. Bump the same version in `package.json` and `.claude-plugin/plugin.json`.
2. Commit and push to `main` (git remote `novacon`; this worktree's branch `plan` pushes with `git push novacon plan:main`, fast-forward only).
3. Tag and push: `git tag -a vX.Y.Z -m "..." && git push novacon vX.Y.Z`.
4. `.github/workflows/publish.yml` then checks the tag matches `package.json`, runs the adapter tests and typecheck, and runs `npm publish`.

Publishing facts:
- npm trusted publishing: the npm package trusts `Novacon/ohmyjev` workflow `publish.yml` with the npm publish permission only (no dist-tag permission). No npm token exists anywhere.
- The package's publishing access is "require 2FA and disallow tokens". If a tagged publish fails with a permissions error, check that setting first.
- Never also run `npm publish` locally for a version the tag will publish: npm refuses a second publish of the same version (this happened with 0.2.0).
- npm account `novacon` has 2FA for auth and writes. `ohmyjev@0.0.0-stage` is a deprecated placeholder; leave it.
- Check a release with `npm view ohmyjev dist-tags` and `gh run list --repo Novacon/ohmyjev --workflow publish.yml`.
