# Contributing to revoice

Thanks for your interest! Issues and PRs are welcome.

## Project layout

The whole tool is three files, so changes are easy to review:

- `bin/revoice.js` — the CLI (Node, zero npm dependencies). Prompt composition, backends (Claude Code CLI, Codex CLI, OpenAI-compatible APIs, Ollama), history, and the learning loop.
- `hammerspoon/revoice.lua` — macOS hotkeys, selection capture, liquid-glass HUD, preview popover, menu bar.
- `install.sh` — installer and config migration.

## Ground rules

- Keep `bin/revoice.js` dependency-free.
- The CLI must stay portable Node (≥18); only the Hammerspoon layer may be macOS-specific.
- Preserve backend isolation: an explicit `--backend X` must never contact another provider.
- Don't weaken the prompt contract (question stays a question, acronyms verbatim, output only the rewritten text).

## Testing

```bash
npm test                  # every suite (CLI + Hammerspoon module); CI runs this on Node 18/20/22
npm test -- reply-mode    # only suites whose filename contains "reply-mode"
npm run check             # syntax: node --check, luac -p, bash -n
```

No API keys, macOS, or npm dependencies are needed. The suites in `test/` run the real `bin/revoice.js` against fake `codex`/`claude` executables and fake Kimi/Ollama HTTP servers (`test/fake-servers.mjs`), asserting the exact argv/request payload each provider receives, exit codes, and that an explicit backend never contacts another one. The `hammerspoon-*.test.lua` suites load the real `hammerspoon/revoice.lua` against a stub `hs` table and drive the hotkeys; they need `lua` (5.3+, `brew install lua` / `apt install lua5.4`) and are skipped otherwise.

Adding a test: copy the pattern in an existing suite — `eq(name, got, want)` with exact values, one `### section` per behaviour, happy path + edge cases + error path — and make sure it fails if you break the code it covers. `.agents/skills/testing-cli/SKILL.md` has the fixture tricks (timeouts, sandboxed `HOME`, installer/migration tests).

For HUD/preview visuals, test on a real Mac: `./install.sh`, then Hammerspoon → Reload Config.

## Submitting

1. Fork and branch.
2. Keep PRs small and focused; describe what changed and why.
3. Run `npm test` and include its summary (plus any manual verification) in the PR.
4. Update `CHANGELOG.md` under an "Unreleased" heading for user-visible changes.
