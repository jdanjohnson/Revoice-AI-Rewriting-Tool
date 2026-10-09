# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Codex / GPT-6 Astra backend** (`--backend codex`): rewrites through your ChatGPT subscription via the Codex CLI (`codex exec`, default model `gpt-6-astra`, `model_reasoning_effort=low`). Options: `CODEX_BIN`, `CODEX_MODEL`, `CODEX_REASONING_EFFORT`, `CODEX_TIMEOUT_MS`.
- **Reply mode** (⌃⇧R): screenshots the frontmost window, asks what you want to say, and drafts the reply in your voice from the on-screen conversation plus your notes (empty notes = infer). Lands in the usual preview. CLI: `revoice --reply [--context TEXT] [--image FILE]...` with notes on stdin. Codex/Astra reads the screenshot natively (`--image`); Claude gets the path with `--allowedTools Read`; Kimi/Ollama receive it as an image part (vision model required). Needs the Screen Recording permission for Hammerspoon; screenshots are deleted from `~/.revoice/tmp` after the run.
- **`REWRITE_BACKEND`** setting (env or `~/.revoice/env`) to choose the default backend or reorder the fallback chain used by the hotkeys, e.g. `REWRITE_BACKEND=codex,claude,kimi,ollama` makes Astra the default. `--backend` accepts the same comma-separated chains.
- **Ollama no longer answers your draft instead of rewriting it**: local models get a compact rewrite-only prompt (`OLLAMA_PROMPT=full` restores the big one), chatty wrappers ("Here is the rewritten draft:", surrounding quotes) are stripped, an output identical to the draft fails instead of being pasted, and an automatic chain that falls through to Ollama now says why on stderr.
- **Test suite + CI**: `npm test` runs the CLI and Hammerspoon-module suites (`test/`) on Linux with no API keys; GitHub Actions runs them on Node 18/20/22 for every PR.
- **`revoice --doctor`**: shows the effective backend chain, where `codex`/`claude` resolve (or why not), Kimi key state, Ollama target, and the `PATH` the CLI sees. Exit 0 when at least one non-Ollama backend is usable.

### Changed
- Automatic chain is now Claude → Codex → Kimi → Ollama (Codex is skipped instantly when the CLI isn't installed).
- In `~/.revoice/env`, the last assignment of a key now wins (so `echo KEY=v >> ~/.revoice/env` overrides an earlier line). Real environment variables still take precedence over the file.

### Fixed
- Hotkeys fell back to Ollama even when `codex`/`claude` worked in the terminal: Hammerspoon launches the CLI with a bare `PATH`, so npm/nvm/volta-installed binaries were invisible. The Hammerspoon module now resolves your login-shell `PATH` (plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`) and passes it to every CLI task.
- Reply mode with Codex failed with `codex exited 1: No prompt provided via stdin.`: `codex exec --image <FILE>...` is greedy and swallowed the prompt argument. Images are now passed as `--image=<FILE>`.

## [1.0.0] - 2026-08-22

First public release.

### Added
- **System-wide rewrite hotkeys** (macOS, via Hammerspoon): select text in any app and press ⌃⇧Z to rewrite it in place.
- **Backend chain with automatic fallback**: Claude Code CLI → any OpenAI-compatible API (e.g. Kimi/Moonshot) → local Ollama. The HUD shows which backend handled each rewrite.
- **Fully editable rewrite prompt** (`~/.revoice/prompt.txt`) — ships with a founder-operator voice guide you can personalize.
- **Voice samples**: paste examples of your real writing into `~/.revoice/voice-samples.txt` and every rewrite imitates their style as few-shot examples.
- **Style hotkeys** ⌃⇧1–4 (founder / casual / professional / concise), each an editable prompt file in `~/.revoice/styles/`.
- **Custom instruction hotkey** ⌃⇧E ("make it shorter", etc.).
- **Context awareness**: tone auto-picked from the frontmost app (Slack → casual, Mail → professional), configurable in `~/.revoice/app-styles.json`.
- **Preview before paste**: ⏎ accept, R regenerate, 1–4 restyle, esc keep the original — nothing is pasted until you accept.
- **Liquid-glass HUD** with live streaming of the rewrite (Kimi/Ollama).
- **Agent skills**: drop any SKILL.md into `~/.revoice/skills/` and its rules apply to every rewrite; two anti-AI-slop skills ship by default.
- **Learning loop**: rejected rewrites are logged and fed back as "don't write like this" examples.
- **Menu-bar item** with recent rewrites, prompt and voice-sample editing.
- **History**: `revoice --history`, `--log-history`, `--mark-last accepted|rejected` against `~/.revoice/history.jsonl`.
- **Zero-dependency Node CLI** (`revoice`), usable standalone: `echo "text" | revoice`.
- Installer (`install.sh`) that sets up Hammerspoon, the CLI, prompts, styles, and skills, and migrates config from the tool's pre-release `~/.spiral-rewrite` layout.

[Unreleased]: https://github.com/jdanjohnson/Revoice-AI-Rewriting-Tool/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jdanjohnson/Revoice-AI-Rewriting-Tool/releases/tag/v1.0.0
