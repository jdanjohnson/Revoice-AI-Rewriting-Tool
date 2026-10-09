#!/usr/bin/env bash
# revoice installer (macOS)
# Installs the CLI to ~/.revoice and wires up the Hammerspoon hotkeys.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.revoice"
OLD_DEST="$HOME/.spiral-rewrite"
HS_DIR="$HOME/.hammerspoon"

echo "==> Checking prerequisites"
command -v node >/dev/null || { echo "Node.js is required: brew install node"; exit 1; }

if ! [ -d "/Applications/Hammerspoon.app" ]; then
  if command -v brew >/dev/null; then
    echo "==> Installing Hammerspoon"
    brew install --cask hammerspoon
  else
    echo "Install Hammerspoon first: https://www.hammerspoon.org/ (or: brew install --cask hammerspoon)"
    exit 1
  fi
fi

# Migrate an existing ~/.spiral-rewrite install (prompt, styles, skills,
# voice samples, env, history, app-styles) into ~/.revoice. Never overwrites
# anything already in ~/.revoice.
if [ -d "$OLD_DEST" ]; then
  echo "==> Migrating existing config from $OLD_DEST to $DEST"
  mkdir -p "$DEST"
  for ITEM in prompt.txt voice-samples.txt env history.jsonl app-styles.json; do
    if [ -f "$OLD_DEST/$ITEM" ] && [ ! -e "$DEST/$ITEM" ]; then
      cp -p "$OLD_DEST/$ITEM" "$DEST/$ITEM"
      echo "    migrated $ITEM"
    fi
  done
  for SUBDIR in styles skills; do
    if [ -d "$OLD_DEST/$SUBDIR" ]; then
      mkdir -p "$DEST/$SUBDIR"
      for F in "$OLD_DEST/$SUBDIR"/*; do
        [ -f "$F" ] || continue
        if [ ! -e "$DEST/$SUBDIR/$(basename "$F")" ]; then
          cp -p "$F" "$DEST/$SUBDIR/"
          echo "    migrated $SUBDIR/$(basename "$F")"
        fi
      done
    fi
  done
  echo "    (old install left untouched at $OLD_DEST — delete it when you're ready)"
fi

# Clean up an old spiral-rewrite Hammerspoon wiring and PATH links.
if [ -f "$HS_DIR/spiral-rewrite.lua" ]; then
  rm -f "$HS_DIR/spiral-rewrite.lua"
  echo "==> Removed old Hammerspoon module: $HS_DIR/spiral-rewrite.lua"
fi
if [ -f "$HS_DIR/init.lua" ] && grep -q 'require("spiral-rewrite")' "$HS_DIR/init.lua"; then
  sed -i '' '/require("spiral-rewrite")/d' "$HS_DIR/init.lua"
  echo "==> Removed old require from $HS_DIR/init.lua"
fi
for BIN_DIR in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  if [ -L "$BIN_DIR/spiral-rewrite" ]; then
    rm -f "$BIN_DIR/spiral-rewrite" 2>/dev/null && echo "==> Removed old CLI link: $BIN_DIR/spiral-rewrite" || true
  fi
done

echo "==> Installing CLI to $DEST"
mkdir -p "$DEST/bin"
cp "$DIR/package.json" "$DEST/"
cp "$DIR/bin/revoice.js" "$DEST/bin/"
cat > "$DEST/bin/revoice" <<EOF
#!/usr/bin/env bash
exec node "$DEST/bin/revoice.js" "\$@"
EOF
chmod +x "$DEST/bin/revoice" "$DEST/bin/revoice.js"

# Put the CLI on PATH
for BIN_DIR in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
    ln -sf "$DEST/bin/revoice" "$BIN_DIR/revoice"
    echo "==> Linked CLI: $BIN_DIR/revoice"
    break
  fi
done

# Editable rewrite prompt (used by all backends).
# Written when missing; an unedited old default is upgraded, user edits are kept.
# Prompt text is derived from the CLI itself so the two can never drift.
NEW_PROMPT="$(node "$DEST/bin/revoice.js" --print-default-prompt)"
OLD_PROMPT_V0='You are a rewriting assistant. Rewrite the user'\''s text to be clearer, more natural, and well-written while preserving its meaning and approximate length. Improve word choice, flow, and structure; do not be timid about rephrasing. Return ONLY the rewritten text with no preamble, quotes, or explanation.'
OLD_PROMPT_V4='You are the ghostwriter for a sharp, confident startup founder. Make the text direct, decisive, and warm but never stiff or corporate: restructure sentences freely, cut filler and hedging ("just", "maybe", "I think", "probably"), lead with the point, and prefer short, punchy sentences. The result should feel transformed, not lightly polished.

The input is a message the author has drafted. Rewrite that draft — you are re-voicing their message, NEVER replying to it: if the draft asks a question, the rewrite asks the same question (do not answer or decide it); a greeting stays a greeting; a list stays a list. Strictly preserve the meaning and intent, every fact, and names, acronyms, and technical terms exactly as written (never expand an acronym). Do not add or remove information. Keep roughly the same length or shorter. Return ONLY the rewritten text with no preamble, quotes, or explanation.'
OLD_PROMPT_V3='You are the ghostwriter for a sharp, confident startup founder. The input is a message the founder has drafted. Rewrite that draft in the founder'\''s voice — you are re-voicing their message, NEVER replying to it: if the draft asks a question, the rewrite asks the same question (do not answer or decide it); a greeting stays a greeting; a list stays a list. Make it direct, decisive, warm but never stiff or corporate: restructure sentences freely, cut filler and hedging ("just", "maybe", "I think", "probably"), lead with the point, and prefer short, punchy sentences. The result should feel transformed, not lightly polished. Strictly preserve the meaning and intent, every fact, and names, acronyms, and technical terms exactly as written (never expand an acronym). Do not add or remove information. Keep roughly the same length or shorter. Return ONLY the rewritten text with no preamble, quotes, or explanation.'
OLD_PROMPT_V1='You are a rewriting assistant. Rewrite the user'\''s text to be clearer, more natural, and better written. Improve word choice, flow, and structure; do not be timid about rephrasing. Strictly preserve the meaning, intent, tone, format (a question stays a question, a greeting stays a greeting), and approximate length. Keep names, acronyms, and technical terms exactly as written. Do not add or remove information. Return ONLY the rewritten text with no preamble, quotes, or explanation.'
OLD_PROMPT_V2='You are an expert editor. Rewrite the user'\''s text so it reads noticeably better, not lightly polished: restructure sentences freely, cut filler and hedging, fix grammar, and choose sharper, more natural wording. Strictly preserve: the meaning and intent; every fact; names, acronyms, and technical terms exactly as written (never expand an acronym); the format (a question stays a question, a greeting stays a greeting, a list stays a list); and the register (casual stays casual, formal stays formal). Do not add or remove information. Keep roughly the same length or shorter. Return ONLY the rewritten text with no preamble, quotes, or explanation.'
if [ ! -f "$DEST/prompt.txt" ]; then
  printf '%s\n' "$NEW_PROMPT" > "$DEST/prompt.txt"
  echo "==> Wrote editable rewrite prompt: $DEST/prompt.txt"
else
  CURRENT="$(cat "$DEST/prompt.txt")"
  if [ "$CURRENT" = "$OLD_PROMPT_V0" ] || [ "$CURRENT" = "$OLD_PROMPT_V1" ] || [ "$CURRENT" = "$OLD_PROMPT_V2" ] || [ "$CURRENT" = "$OLD_PROMPT_V3" ] || [ "$CURRENT" = "$OLD_PROMPT_V4" ]; then
    printf '%s\n' "$NEW_PROMPT" > "$DEST/prompt.txt"
    echo "==> Upgraded rewrite prompt to the new default: $DEST/prompt.txt"
  fi
fi

# Editable style prompts for the ⌃⇧1–4 hotkeys (written only if missing)
mkdir -p "$DEST/styles"
for STYLE in founder casual professional concise; do
  if [ ! -f "$DEST/styles/$STYLE.txt" ]; then
    STYLE_PROMPT="$(node "$DEST/bin/revoice.js" --print-style-prompt "$STYLE")"
    printf '%s\n' "$STYLE_PROMPT" > "$DEST/styles/$STYLE.txt"
    echo "==> Wrote style prompt: $DEST/styles/$STYLE.txt"
  fi
done

# Agent skills appended to every rewrite prompt (written only if missing;
# edit or delete files in $DEST/skills to customize, add your own .md skills)
mkdir -p "$DEST/skills"
for SKILL_FILE in "$DIR"/skills/*.md; do
  [ -f "$SKILL_FILE" ] || continue
  BASENAME="$(basename "$SKILL_FILE")"
  if [ ! -f "$DEST/skills/$BASENAME" ]; then
    cp "$SKILL_FILE" "$DEST/skills/$BASENAME"
    echo "==> Wrote skill: $DEST/skills/$BASENAME"
  fi
done

echo "==> Wiring Hammerspoon config"
mkdir -p "$HS_DIR"
cp "$DIR/hammerspoon/revoice.lua" "$HS_DIR/revoice.lua"
if ! grep -q 'require("revoice")' "$HS_DIR/init.lua" 2>/dev/null; then
  printf '\nrequire("revoice")\n' >> "$HS_DIR/init.lua"
fi

echo
echo "Done. Next steps:"
echo "  1. Open Hammerspoon, grant Accessibility permission, and click 'Reload Config'."
echo "  2. Backends (any one works): Claude Code CLI (npm i -g @anthropic-ai/claude-code; run 'claude' once) or Codex / GPT-6 Astra (npm i -g @openai/codex; run 'codex' once)."
echo "     Want Astra first? Put REWRITE_BACKEND=codex,claude,kimi,ollama in $DEST/env."
echo "  3. (Optional) OpenAI API, paid per token but ~3s and streaming: put OPENAI_API_KEY=sk-... in $DEST/env (model gpt-6-astra; REWRITE_BACKEND=openai to use only it)."
echo "     (Optional) Kimi backend: put KIMI_API_KEY=... in $DEST/env.  (Optional local fallback) brew install ollama && ollama pull llama3.2:3b"
echo "  4. Edit the rewrite prompt anytime: $DEST/prompt.txt"
echo "  5. Want rewrites in YOUR voice? Paste samples of your real writing (separated by --- lines) into $DEST/voice-samples.txt"
echo "  6. Select text anywhere and press ⌃⇧Z to rewrite, ⌃⇧E for a custom instruction, or ⌃⇧1–4 for styles (founder/casual/professional/concise — editable in $DEST/styles/)."
