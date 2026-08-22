---
name: testing-revoice-cli
description: How to test the revoice Node CLI on Linux against the repo's fake servers, without macOS/Hammerspoon.
---

# Testing revoice CLI on Linux

The CLI (`bin/revoice.js`) is fully testable without macOS by pointing it at the fake server in `test/`:

```bash
node test/fake-ollama-server.js & # /api/chat on 127.0.0.1:4598, replies "OLLAMA(<model>): <text>"
export OLLAMA_URL=http://127.0.0.1:4598
echo "hello" | node bin/revoice.js
```

Tips:
- The CLI has zero npm dependencies — no `npm install` needed.
- The fakes are ESM; scripts copied outside the repo need a `.mjs` extension.
- To prove "never contacts Ollama", run a copy of the fake ollama that appends each request body to a log file and assert the line count.
- Timeout tests: use an HTTP server that accepts but never responds. Note the code clamps each leg's timeout to a minimum of 10s (`Math.max(deadline-now, 10000)`), so REWRITE_TIMEOUT_MS below 10000 still takes ~10s. CLAUDE_TIMEOUT_MS is NOT clamped (min with remaining deadline) — test with a `sleep 20` fake claude.
- Simulate TTY stdin with `script -qec "node bin/revoice.js" /dev/null`.

## Claude / Kimi backends
- Fake claude = executable bash script (set `CLAUDE_BIN=/path/to/script`) that cats stdin and echoes `"$2"` (the -p prompt); log invocations to a file to prove isolation. A script that `exit 1` without reading stdin exercises the EPIPE guard. Have it log the full `-p` prompt AND captured stdin bytes to distinguish prompt-embedded drafts from stdin-passed drafts. Recreate `/tmp` fixtures each run (they may be wiped) and health-check them before asserting.
- Fake Kimi = OpenAI-compatible `/chat/completions` HTTP server; set `KIMI_API_URL=http://127.0.0.1:PORT` and `KIMI_API_KEY`. Log request JSON (model, system message, Authorization header) to assert prompt/env-file effects.
- Isolate the `~/.revoice/env` and `prompt.txt` files by running with `HOME=/tmp/some-dir`.
- install.sh can run on Linux non-interactively: `mkdir -p /Applications/Hammerspoon.app` to satisfy the macOS check, then `HOME=/tmp/x bash install.sh </dev/null`. Note it uses BSD `sed -i ''` for init.lua cleanup, which fails on GNU sed — pre-create an init.lua without the old require line, or skip that path.
- findClaude PATH scan: verify it skips a directory named `claude` and a non-executable file named `claude` earlier in PATH.
- OLD_PROMPT_V* upgrade matrix in install.sh: extract with an awk state machine (`/^OLD_PROMPT_V/{f=1} f{print} f && /explanation\.'$/{f=0}`) sourced in an isolated subshell — never `eval` grepped install.sh lines in your main shell (trailing script lines can execute with empty vars).
- Agent skills: use `REWRITE_SKILLS_DIR` + tiny fixed-length skill files to hit `SKILLS_MAX_CHARS` boundaries deterministically. Assert prompt composition by constructing the full expected system string in node and `===`-comparing against the logged request body, not by substring checks.
- Migration: create a fake `~/.spiral-rewrite` under an isolated `HOME` with sentinel file contents; assert every file lands in `~/.revoice`, and that pre-existing `~/.revoice` files are never overwritten.
- `REWRITE_TIMEOUT_MS` values below 10000 are clamped to the 10s per-provider floor, so timeout tests need a fake provider that takes >10s.
- The installer only creates a PATH link if an existing writable BIN_DIR (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`) is found — pre-create `$HOME/.local/bin` in sandbox HOMEs.
