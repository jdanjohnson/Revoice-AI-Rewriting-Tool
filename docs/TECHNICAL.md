# revoice — technical reference

Everything under the hood. For the friendly tour, see the [README](../README.md).

## Architecture

```
Hammerspoon hotkey
  → copies selection (preserves your clipboard)
  → pipes it to the revoice CLI (Node, zero dependencies), which tries in order:
      1. Claude Code CLI (your Claude subscription — your own prompt)
      2. Codex CLI (your ChatGPT subscription, default model gpt-6-astra — your own prompt)
      3. OpenAI API, paid per token (if OPENAI_API_KEY is set — gpt-6-astra, streams, your own prompt)
      4. Kimi / any OpenAI-compatible API (if KIMI_API_KEY is set — your own prompt)
      5. Ollama at localhost:11434 (local, default model llama3.2:3b — compact prompt, see below)
     (reorder with REWRITE_BACKEND, e.g. codex,claude,kimi,ollama)
  → streams the rewrite into the liquid-glass HUD
  → shows a preview popover — ⏎ pastes over the selection, esc keeps the original
    (ambiguities the model flagged appear as ⚑ chips under the text; they are never pasted)
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

1. **The rewrite prompt** — `~/.revoice/prompt.txt` (or a style file, see below). Claude, Codex, OpenAI and Kimi use it; Ollama only with `OLLAMA_PROMPT=full` (by default it gets a short rewrite-only prompt plus the active style and instruction, because small local models can't follow the full guide — see Backends). Override the path with `REWRITE_PROMPT_FILE`.
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

In `auto` mode (the hotkeys) the CLI tries Claude → Codex → OpenAI → Kimi → Ollama; the HUD shows which one handled the rewrite. An explicit `--backend X` never contacts another provider.

`REWRITE_BACKEND` (env or `~/.revoice/env`) changes the default chain used by the hotkeys. It accepts a single backend (`codex` — strict, no fallback), `auto`, or a comma-separated chain (`codex,claude,kimi,ollama` — GPT-6 Astra first, then the usual fallbacks). `--backend` on the command line takes the same values and overrides it. OpenAI and Kimi are skipped in an automatic chain when their key (`OPENAI_API_KEY` / `KIMI_API_KEY`) is unset; `--backend openai` with no key is a hard error.

- **Claude**: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in. Options: `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_TIMEOUT_MS`.
- **Codex / GPT-6 Astra**: `npm i -g @openai/codex` (≥ 0.153), then run `codex` once to sign in with your ChatGPT account (Plus/Pro/Business). revoice runs `codex exec --ephemeral --sandbox read-only --model gpt-6-astra -c model_reasoning_effort="low"` and reads the final message via `--output-last-message`, so Codex's progress output never reaches the paste. Options: `CODEX_BIN`, `CODEX_MODEL` (default `gpt-6-astra`), `CODEX_REASONING_EFFORT` (default `low` — raise to `medium`/`high` for long strategy docs, at the cost of latency), `CODEX_TIMEOUT_MS`. Prefer the API instead? See the OpenAI backend below.
- **OpenAI API (paid per token)**: put `OPENAI_API_KEY=sk-...` (from platform.openai.com) in `~/.revoice/env`. Same Astra model as Codex, but through the Chat Completions API: ~3 s instead of 10–20 s of CLI startup, and the text streams into the HUD. Costs money per rewrite (Astra is $10/$50 per M tokens — roughly $0.10–0.20 per rewrite with a full voice guide + skills + samples). Options: `OPENAI_MODEL` (default `gpt-6-astra`), `OPENAI_REASONING_EFFORT` (default `low`; `off|none|minimal|low|medium|high|xhigh|max`, sent as `reasoning_effort`; `off` omits the field, which you need if `OPENAI_MODEL` is a non-reasoning model such as `gpt-4o`; support for the other values is model-dependent, e.g. Astra rejects `none` with HTTP 400), `OPENAI_API_URL` (default `https://api.openai.com/v1`). No temperature is sent. `REWRITE_BACKEND=openai` makes it the only backend; by default it sits after Codex in the chain so the free path still goes first.
- **Kimi / any OpenAI-compatible API**: put `KIMI_API_KEY=sk-...` (from platform.moonshot.ai) in `~/.revoice/env` — that file is loaded by the CLI even when launched from the hotkey. Options: `KIMI_MODEL` (default `moonshot-v1-auto`), `KIMI_API_URL` (point it at any OpenAI-compatible endpoint), `KIMI_TEMPERATURE` (unset by default — Moonshot's `kimi-k*` models reject non-default temperatures).
- **Ollama (local/free)**: `brew install ollama && ollama pull llama3.2:3b` (~2 GB, fast on Apple Silicon). Options: `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX` (default 8192), `OLLAMA_PROMPT` (`compact` default / `full`). Small local models can't follow the full voice guide + skills + samples — they answer the draft instead of rewriting it — so Ollama gets a short rewrite-only prompt (plus the active style and any instruction) unless you set `OLLAMA_PROMPT=full` for a bigger model (e.g. `OLLAMA_MODEL=llama3.1:8b`). Output that only echoes the draft is treated as a failure, never pasted. When an automatic chain ends up on Ollama because the others failed, the CLI says so on stderr (`revoice: codex: … — falling back to local Ollama`).

## Reply mode (⌃⇧R)

The rewrite hotkeys only ever see the text you selected. Reply mode adds the conversation itself:

1. Hammerspoon snapshots the frontmost window (`hs.window:snapshot()`, downscaled to ≤1800px wide) to `~/.revoice/tmp/reply-<ms>.png`. This needs the **Screen Recording** permission for Hammerspoon; if the snapshot fails and nothing is selected, the hotkey aborts with a hint.
2. Any selected text is copied as extra `--context` (select the message you're answering for text-only backends).
3. A prompt box asks what you want to say; rough notes are fine, empty means "infer from the conversation".
4. The CLI runs `revoice --reply --image <png> [--context <sel>]` with the notes on stdin, using the same style/backend/skills/voice samples as a rewrite.
5. The result lands in the normal preview (⏎ paste, R regenerate, 1–4 restyle, esc discard). Regenerate/restyle reuse the same screenshot; screenshots older than two minutes are deleted from `~/.revoice/tmp` when a run finishes.

Prompt-wise, the system prompt is unchanged for Claude/Codex/OpenAI/Kimi (voice guide → skills → rejected examples → samples → instruction); compact-mode Ollama gets a short reply-drafting prompt instead of its rewrite-only one. The task message is a *reply brief* instead of the draft block: it states that reply mode overrides the "never reply" rewrite rule, carries the conversation context and your notes, forbids inventing facts/dates/commitments, and asks for only the send-ready reply.

How each backend receives the screenshot:

| Backend | Image transport |
|---------|-----------------|
| Codex / GPT-6 Astra | `codex exec --image <file>` (native; recommended) |
| Claude Code | The file path is appended to the prompt with `--allowedTools Read`, so Claude reads the PNG itself |
| OpenAI API | `image_url` content part with a base64 data URL; the default `gpt-6-astra` reads screenshots |
| Kimi / OpenAI-compatible | same `image_url` content part (needs a vision-capable `KIMI_MODEL`) |
| Ollama | `images: [<base64>]` on the user message (needs a vision-capable `OLLAMA_MODEL`; the default `llama3.2:3b` is text-only) |

A text-only model on OpenAI/Kimi/Ollama will either ignore the image or return a provider error, which the chain then treats like any other failure. Nothing is captured or uploaded unless you press ⌃⇧R.

## CLI usage (standalone)

```bash
echo "some text" | revoice                        # Claude → Codex → OpenAI → Kimi → Ollama (or REWRITE_BACKEND)
echo "some text" | revoice -i "make it formal"    # custom instruction
echo "some text" | revoice --style casual         # style prompt (founder|casual|professional|concise|any styles/*.txt)
echo "some text" | revoice --backend claude       # Claude only
echo "some text" | revoice --backend codex        # Codex / GPT-6 Astra only
echo "some text" | revoice --backend codex,ollama # custom chain: Astra, then local fallback
echo "some text" | revoice --backend openai       # OpenAI API only (paid, fast, streams)
echo "some text" | revoice --backend kimi         # Kimi only
echo "some text" | revoice --backend ollama       # local only
revoice --skills                                  # list loaded agent skills
revoice --doctor                                  # which backends resolve, effective chain, PATH the CLI sees
echo "some text" | revoice --stream               # stream output chunks as they arrive (OpenAI/Kimi; Ollama is buffered so its output can be checked first)
echo "some text" | revoice --log-history          # record the rewrite in ~/.revoice/history.jsonl
revoice --history                                 # print recent rewrites (newest first)
revoice --mark-last accepted|rejected             # record the outcome of the last rewrite
echo "yes, but not before fri" | revoice --reply --image thread.png   # draft a reply from a screenshot + notes
echo "" | revoice --reply --context "$(pbpaste)"                     # reply to copied text, let the model infer
```

`--reply` accepts empty stdin as long as `--context` or at least one `--image` is given; `--image` may be repeated. `--context`/`--image` are rejected outside reply mode.

## Environment variables

May also live in `~/.revoice/env` (quote values that contain ` #`). Real environment variables win over the file; within the file the last assignment of a key wins, so appending with `>>` overrides. Hammerspoon passes your login-shell `PATH` (plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`) to the CLI so npm/nvm-installed `codex`/`claude` are found from the hotkeys.

`REWRITE_PROMPT_FILE`, `REWRITE_BACKEND`, `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_TIMEOUT_MS`, `CODEX_BIN`, `CODEX_MODEL`, `CODEX_REASONING_EFFORT`, `CODEX_TIMEOUT_MS`, `OPENAI_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `KIMI_API_URL`, `KIMI_API_KEY`, `KIMI_MODEL`, `KIMI_TEMPERATURE`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `REWRITE_TIMEOUT_MS` (default 25000), `VOICE_SAMPLES_FILE`, `VOICE_MAX_CHARS`, `REWRITE_STYLES_DIR`, `REWRITE_SKILLS_DIR`, `SKILLS_MAX_CHARS`, `REWRITE_HISTORY_FILE`, `REJECTED_EXAMPLES_MAX`.

## Security & privacy

- The hotkey sends whatever text is selected — and, for ⌃⇧R, a screenshot of the frontmost window — to a remote API (Claude, OpenAI/Codex, or Kimi) unless you use `--backend ollama`. Screenshots are only taken when you press ⌃⇧R and are deleted from `~/.revoice/tmp` after the run. Don't trigger it on passwords, keys, or other secrets — there is no per-invocation confirmation by design (it's a one-keystroke tool).
- Endpoint/key env vars are only read from your own environment or `~/.revoice/env`; only set them to endpoints you trust. Use `--backend ollama` to keep text fully local.
- Rewrite history, voice samples, and your prompt live only in `~/.revoice/` on your machine.

## Troubleshooting

**HUD says `ollama` (or the wrong backend) but the terminal works.** The hotkeys run the same CLI, but under Hammerspoon's environment. Run `revoice --doctor` in Terminal: it prints the effective chain, where `codex`/`claude` were found, and the `PATH` in use. The same report is one click away as ✍️ menu → **Run doctor**, and ✍️ → **Backend** switches `REWRITE_BACKEND` in `~/.revoice/env` without opening a terminal (Auto removes the line; other lines in the file are left alone). Then Hammerspoon menu → Reload Config (the module caches your login-shell `PATH` at load). If the binaries live somewhere unusual, set `CODEX_BIN=/full/path/to/codex` / `CLAUDE_BIN=...` in `~/.revoice/env`. If `~/.revoice/env` has several `REWRITE_BACKEND=` lines, the last one wins.

## Limitations

- macOS only: the global hotkeys, selection capture, and paste rely on Hammerspoon. The CLI itself is portable Node and works anywhere.
- Works in any app that supports ⌘C/⌘V (Mail, Slack, browsers, editors).
- **Ambiguity flags.** The system prompt asks the model to append one `FLAGS: a | b` line only when the draft could materially be read two ways. The CLI strips that line from stdout (in `--stream` mode a line that starts like `FLAGS:` is held back, so it never reaches the HUD) and prints each flag on stderr as `flag:<text>`; Hammerspoon turns those into amber chips in the preview. `FLAGS: none`, bullets and `|` separators are all accepted; Ollama's compact prompt doesn't ask for flags.
- The Claude Code and Codex CLIs can't stream, so their rewrites show the animated HUD and then pop straight into the preview; OpenAI/Kimi stream live; Ollama is buffered (its output is cleaned and checked before anything is shown). Both CLIs also add a few seconds of startup per rewrite.

## Testing

`npm test` runs the full suite (CLI against fake codex/claude/OpenAI/Kimi/Ollama, plus the Hammerspoon module under a stub `hs`) on Linux with no API keys — see [CONTRIBUTING.md](../CONTRIBUTING.md). CI runs it on Node 18/20/22. `test/fake-ollama-server.js` is a standalone fake Ollama for poking at the CLI by hand.
