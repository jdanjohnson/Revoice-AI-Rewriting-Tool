# Contributing to revoice

Thanks for your interest! Issues and PRs are welcome.

## Project layout

The whole tool is three files, so changes are easy to review:

- `bin/revoice.js` — the CLI (Node, zero npm dependencies). Prompt composition, backends (Claude Code CLI, OpenAI-compatible APIs, Ollama), history, and the learning loop.
- `hammerspoon/revoice.lua` — macOS hotkeys, selection capture, liquid-glass HUD, preview popover, menu bar.
- `install.sh` — installer and config migration.

## Ground rules

- Keep `bin/revoice.js` dependency-free.
- The CLI must stay portable Node (≥18); only the Hammerspoon layer may be macOS-specific.
- Preserve backend isolation: an explicit `--backend X` must never contact another provider.
- Don't weaken the prompt contract (question stays a question, acronyms verbatim, output only the rewritten text).

## Testing

The CLI is fully testable on Linux without macOS or real API keys:

```bash
node --check bin/revoice.js
node test/fake-ollama-server.js &   # fake Ollama on 127.0.0.1:4598
OLLAMA_URL=http://127.0.0.1:4598 sh -c 'echo "hello" | node bin/revoice.js --backend ollama'
```

See `.agents/skills/testing-cli/SKILL.md` for the full testing playbook (fake Claude/Kimi fixtures, timeout behavior, installer/migration tests with a sandboxed `HOME`).

For Hammerspoon changes, test on a real Mac: `./install.sh`, then Hammerspoon → Reload Config.

## Submitting

1. Fork and branch.
2. Keep PRs small and focused; describe what changed and why.
3. Include the actual commands/output you used to verify.
4. Update `CHANGELOG.md` under an "Unreleased" heading for user-visible changes.
