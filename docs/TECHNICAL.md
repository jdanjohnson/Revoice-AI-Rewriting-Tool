# revoice — technical reference

Everything under the hood. For the friendly tour, see the [README](../README.md).

## Architecture

```
Hammerspoon hotkey
  → copies selection (preserves your clipboard)
  → pipes it to the revoice CLI (Node, zero dependencies), which tries in order:
      1. Claude Code CLI (your Claude subscription — your own prompt)
      2. Kimi / any OpenAI-compatible API (if KIMI_API_KEY is set — your own prompt)
      3. Ollama at localhost:11434 (local, default model llama3.2:3b — your own prompt)
  → streams the rewrite into the liquid-glass HUD
  → shows a preview popover — ⏎ pastes over the selection, esc keeps the original
  → restores your clipboard either way
```

The whole tool is three files:

- `bin/revoice.js` — the CLI. Prompt composition, backends, history, learning loop. Portable Node ≥18, zero npm dependencies.
- `hammerspoon/revoice.lua` — hotkeys, selection capture, HUD, preview popover, menu bar (macOS).
- `install.sh` — installer and config migration.

## What the installer does

1. Installs Hammerspoon (via Homebrew) if missing.
2. Installs the CLI to `~/.revoice`, links `revoice` onto your PATH, and writes the editable `prompt.txt`, style prompts, and default skills.
3. Adds the hotkeys to `~/.hammerspoon/init.lua`.
4. Migrates any existing `~/.spiral-rewrite` config (prompt, styles, skills, voice samples, env, history) without overwriting anything.

Re-running it is safe (idempotent); it never overwrites files you've edited.

## Prompt composition

Every rewrite prompt is assembled from, in order:

1. **The rewrite prompt** — `~/.revoice/prompt.txt` (or a style file, see below). All backends use it. Override the path with `REWRITE_PROMPT_FILE`.
2. **Agent skills** — every `.md` file in `~/.revoice/skills/` (YAML frontmatter stripped) is appended as strict rules. Two anti-AI-slop skills ship by default. `revoice --skills` lists what's loaded; `SKILLS_MAX_CHARS` (default 16000) caps the total.
3. **Voice samples** — `~/.revoice/voice-samples.txt`, samples separated by `---` lines, included as few-shot style examples ("imitate the style, not the content"). `VOICE_MAX_CHARS` (default 6000) caps how much is sent.
4. **Negative examples** — the last few rejected rewrites from history, as "don't write like this" examples. `REJECTED_EXAMPLES_MAX` (default 3, 0 disables).
5. **The custom instruction**, if any (⌃⇧E / `-i`).
6. **The draft itself** — embedded at the end of the prompt (not stdin) so large prompts never lose it.

## Styles

Each style is an editable prompt file in `~/.revoice/styles/` (`founder.txt`, `casual.txt`, `professional.txt`, `concise.txt`). Any `NAME.txt` you add works via `--style NAME`. `REWRITE_STYLES_DIR` overrides the directory.

## Context awareness

⌃⇧Z picks a tone from the frontmost app (chat apps → casual, email apps → professional). Override per app in `~/.revoice/app-styles.json`, e.g.:

```json
{ "com.tinyspeck.slackmacgap": "founder", "com.apple.mail": "" }
```

(empty string = use the main voice guide).

## Backends

In `auto` mode (the hotkeys) the CLI tries Claude → Kimi → Ollama; the HUD shows which one handled the rewrite. An explicit `--backend X` never contacts another provider.

- **Claude**: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in. Options: `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_TIMEOUT_MS`.
- **Kimi / any OpenAI-compatible API**: put `KIMI_API_KEY=sk-...` (from platform.moonshot.ai) in `~/.revoice/env` — that file is loaded by the CLI even when launched from the hotkey. Options: `KIMI_MODEL` (default `moonshot-v1-auto`), `KIMI_API_URL` (point it at any OpenAI-compatible endpoint), `KIMI_TEMPERATURE` (unset by default — Moonshot's `kimi-k*` models reject non-default temperatures).
- **Ollama (local/free)**: `brew install ollama && ollama pull llama3.2:3b` (~2 GB, fast on Apple Silicon). Options: `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX` (default 8192).

## CLI usage (standalone)

```bash
echo "some text" | revoice                        # Claude → Kimi → Ollama
echo "some text" | revoice -i "make it formal"    # custom instruction
echo "some text" | revoice --style casual         # style prompt (founder|casual|professional|concise|any styles/*.txt)
echo "some text" | revoice --backend claude       # Claude only
echo "some text" | revoice --backend kimi         # Kimi only
echo "some text" | revoice --backend ollama       # local only
revoice --skills                                  # list loaded agent skills
echo "some text" | revoice --stream               # stream output chunks as they arrive (Kimi/Ollama)
echo "some text" | revoice --log-history          # record the rewrite in ~/.revoice/history.jsonl
revoice --history                                 # print recent rewrites (newest first)
revoice --mark-last accepted|rejected             # record the outcome of the last rewrite
```

## Environment variables

May also live in `~/.revoice/env` (quote values that contain ` #`):

`REWRITE_PROMPT_FILE`, `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_TIMEOUT_MS`, `KIMI_API_URL`, `KIMI_API_KEY`, `KIMI_MODEL`, `KIMI_TEMPERATURE`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `REWRITE_TIMEOUT_MS` (default 25000), `VOICE_SAMPLES_FILE`, `VOICE_MAX_CHARS`, `REWRITE_STYLES_DIR`, `REWRITE_SKILLS_DIR`, `SKILLS_MAX_CHARS`, `REWRITE_HISTORY_FILE`, `REJECTED_EXAMPLES_MAX`.

## Security & privacy

- The hotkey sends whatever text is selected to a remote API (Claude or Kimi) unless you use `--backend ollama`. Don't trigger it on passwords, keys, or other secrets — there is no per-invocation confirmation by design (it's a one-keystroke tool).
- Endpoint/key env vars are only read from your own environment or `~/.revoice/env`; only set them to endpoints you trust. Use `--backend ollama` to keep text fully local.
- Rewrite history, voice samples, and your prompt live only in `~/.revoice/` on your machine.

## Limitations

- macOS only: the global hotkeys, selection capture, and paste rely on Hammerspoon. The CLI itself is portable Node and works anywhere.
- Works in any app that supports ⌘C/⌘V (Mail, Slack, browsers, editors).
- Claude Code CLI can't stream, so Claude rewrites show the animated HUD and then pop straight into the preview; Kimi/Ollama stream live.

## Testing

The CLI is fully testable on Linux without macOS or real API keys — see [CONTRIBUTING.md](../CONTRIBUTING.md) and `.agents/skills/testing-cli/SKILL.md`. `test/fake-ollama-server.js` provides a local fake Ollama for offline testing.
