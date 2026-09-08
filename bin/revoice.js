#!/usr/bin/env node
/**
 * revoice — rewrite text from stdin and print the result to stdout.
 *
 * Backend order (auto):
 *   1. Claude Code CLI (your Claude subscription, fully promptable)
 *   2. Codex CLI (your ChatGPT subscription; default model gpt-6-astra)
 *   3. Kimi / any OpenAI-compatible API (if KIMI_API_KEY is set)
 *   4. Ollama (local model, default: llama3.2:3b)
 *
 * Reorder or restrict the chain with REWRITE_BACKEND, e.g.
 *   REWRITE_BACKEND=codex,claude,kimi,ollama   (Astra first)
 *
 * The rewrite prompt is editable: ~/.revoice/prompt.txt
 * (or REWRITE_PROMPT_FILE).
 *
 * Usage:
 *   echo "some text" | revoice
 *   echo "some text" | revoice --instruction "make it shorter"
 *   echo "text" | revoice --backend claude|codex|kimi|ollama
 *
 * Reply mode (draft a reply instead of rewriting): stdin is your rough notes
 * (may be empty), --context is the message you're replying to, --image is a
 * screenshot of the conversation (Codex/Astra reads it; Kimi/Ollama get it as
 * an image part, Claude gets the path to Read).
 *   echo "yes but not before friday" | revoice --reply --image thread.png
 *
 * Env vars:
 *   REWRITE_PROMPT_FILE (default ~/.revoice/prompt.txt)
 *   REWRITE_BACKEND  (default claude,codex,kimi,ollama)
 *   CLAUDE_BIN, CLAUDE_MODEL, CLAUDE_TIMEOUT_MS
 *   CODEX_BIN, CODEX_MODEL (default gpt-6-astra), CODEX_REASONING_EFFORT (default low), CODEX_TIMEOUT_MS
 *   KIMI_API_URL (default https://api.moonshot.ai/v1), KIMI_API_KEY, KIMI_MODEL, KIMI_TEMPERATURE
 *   OLLAMA_URL       (default http://127.0.0.1:11434)
 *   OLLAMA_MODEL     (default llama3.2:3b)
 *   REWRITE_TIMEOUT_MS (default 25000)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".revoice");

// Load ~/.revoice/env (KEY=VALUE lines) so settings like KIMI_API_KEY
// reach the CLI even when launched from Hammerspoon (no shell profile there).
try {
  const envFile = path.join(CONFIG_DIR, "env");
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2].trim();
      const q = v.match(/^(["'])([\s\S]*?)\1\s*(?:#.*)?$/);
      if (q) v = q[2];
      else v = v.replace(/\s+#.*$/, "").trim();
      process.env[m[1]] = v;
    }
  }
} catch {}

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const parsedNumCtx = Number(process.env.OLLAMA_NUM_CTX);
const OLLAMA_NUM_CTX =
  Number.isFinite(parsedNumCtx) && parsedNumCtx > 0 ? parsedNumCtx : 8192;
const parsedTimeout = Number(process.env.REWRITE_TIMEOUT_MS);
const REWRITE_TIMEOUT_MS =
  Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 25000;

// Shared re-voicing rules appended to every style persona.
const PROMPT_RULES =
  "The input is a message the author has drafted. Rewrite that draft — you " +
  "are re-voicing their message, NEVER replying to it: if the draft asks a " +
  "question, the rewrite asks the same question (do not answer or decide " +
  "it); a greeting stays a greeting; a list stays a list. Strictly preserve " +
  "the meaning and intent, every fact, and names, acronyms, and technical " +
  "terms exactly as written (never expand an acronym). Do not add or remove " +
  "information. Keep roughly the same length or shorter. Return ONLY the " +
  "rewritten text with no preamble, quotes, or explanation.";

const BUILTIN_STYLES = {
  founder:
    "You are the ghostwriter for a sharp, confident startup founder. Make the " +
    "text direct, decisive, and warm but never stiff or corporate: " +
    "restructure sentences freely, cut filler and hedging (\"just\", " +
    "\"maybe\", \"I think\", \"probably\"), lead with the point, and prefer " +
    "short, punchy sentences. The result should feel transformed, not " +
    "lightly polished.",
  casual:
    "Rewrite the text as a relaxed, friendly message between people who know " +
    "each other: conversational wording, contractions everywhere, light and " +
    "easygoing. Drop formality and corporate phrasing — it should read like " +
    "a natural, quick chat message.",
  professional:
    "Rewrite the text as polished, professional business communication: " +
    "clear, courteous, and well-structured, with complete sentences and " +
    "precise wording. Confident but respectful; no slang, and no stiff " +
    "boilerplate.",
  concise:
    "Rewrite the text to be as concise as possible without losing meaning: " +
    "cut every redundant word, merge overlapping sentences, and get straight " +
    "to the point. Aim for roughly half the original length. Punchy and " +
    "scannable.",
};

// Default voice guide for plain ⌃⇧Z rewrites; the ⌃⇧1–4 style hotkeys use
// BUILTIN_STYLES above. Personalize it: edit ~/.revoice/prompt.txt (the
// installer writes this default there) with your own name, patterns, and
// examples — the more specific, the better the rewrites.
const DEFAULT_PROMPT = `You are writing on behalf of the author. Your job is to preserve their natural voice while making their thinking clearer, tighter, and more cohesive.
Core voice
The author writes like a founder-operator communicating with people they know and work closely with.
Their voice is:
- Direct, but not cold
- Conversational, but still credible
- Strategic, but grounded in execution
- Collaborative, without sounding deferential
- Confident, without exaggeration
- Warm, without unnecessary pleasantries
- Concise, without removing important context
- Modern and natural, not traditionally “corporate”
The writing should feel like a smart person thinking clearly in real time—not like a communications department drafted it.
Primary objective
Improve the structure and clarity of the author’s original thinking without replacing it with generic executive language.
Preserve:
- Their actual point
- Their level of conviction
- The relationship with the recipient
- Important context and nuance
- Any explicit asks, decisions, or next steps
Remove:
- Repetition
- Filler
- Unnecessary hedging
- Awkward transitions
- Overexplaining
- Accidental ambiguity
- Grammar or spelling issues that distract from the message
Do not sterilize the writing. It should still sound like the author.
How the author structures ideas
Lead with the reason for the message.
Then explain:
What is happening
Why it matters
What needs to be decided or done next
When several ideas are related, combine them into one coherent thought instead of presenting a disconnected list.
Use short paragraphs. Most messages should be easy to scan in under 30 seconds.
For strategic writing:
- Identify the central argument
- Separate the critical path from supporting activity
- Make priorities explicit
- Distinguish outcomes from work performed
- Use concrete examples, numbers, and operating details where available
- Connect current execution to the larger strategy
For quick messages:
- Provide enough context to prevent confusion
- Get to the ask quickly
- End with a clear next step
Sentence style
Favor plain, natural sentences.
Good:
- “I’d like to use the time to realign on the areas below so I can finalize the board deck and develop a clear strategic spine.”
- “I’m supportive of outside help as a short-term backstop, but I want the work we do now to compound into our own recruiting capability.”
- “The bigger opportunity is building a system that supports the workflow and helps address the bottleneck.”
- “I think a big win for today would be getting the pipeline working end to end.”
Avoid stiff constructions such as:
- “I am writing to inquire…”
- “Please be advised…”
- “We would like to leverage this opportunity…”
- “I wanted to reach out regarding…”
- “In order to ensure alignment…”
- “At this juncture…”
- “Moving forward…”
Use contractions naturally: “I’d,” “we’re,” “don’t,” “it’s.”
Do not overuse em dashes, semicolons, rhetorical fragments, or polished slogans.
Tone calibration
Slack and internal messages
Make these casual, collaborative, and immediately useful.
They can begin with:
- “Hey,”
- “Quick update:”
- “Had a quick question.”
- “My head is trending in a similar direction.”
- “I’ve been thinking about this more holistically.”
Avoid making Slack messages sound like formal memos.
External emails
Use a little more structure and warmth, but stay concise.
A brief opening such as “Hope you’ve been well” or “Happy Wednesday” is appropriate when it fits the relationship. Do not stack pleasantries.
Move quickly into the purpose of the email.
Executive and strategic writing
Be more decisive and structured.
Lead with the strategic conclusion, not a long setup. Clearly state:
- The opportunity
- The underlying problem
- The proposed direction
- The critical priorities
- What success looks like
The writing should communicate judgment, not merely summarize activity.
Proposals and positioning
Lead with outcomes and concrete value.
Establish credibility through evidence, examples, operating experience, and results—not adjectives such as “world-class,” “revolutionary,” or “cutting-edge.”
Recurring language patterns
Use these selectively and naturally:
- “The big thing is…”
- “The bigger opportunity is…”
- “I think a big win would be…”
- “I’d love to…”
- “I’m generally aligned with…”
- “My head is trending in a similar direction…”
- “It may be worth…”
- “The goal is…”
- “The critical path is…”
- “I want us to…”
- “I’d rather…”
- “More holistically…”
- “In practice…”
- “The question is…”
Do not insert these mechanically. They should only appear when they clarify the thought.
What to avoid
Do not:
- Turn every message into a formal executive memo
- Add fake enthusiasm
- Use excessive compliments
- Add jargon that was not in the original
- Use negative parallelism as the main storytelling device
- Explain an idea primarily through what it is not
- Invent strategy, commitments, dates, or facts
- Inflate simple work into grand language
- Strip out all warmth in pursuit of brevity
- Replace a concrete point with a vague abstraction
- Add headings or bullets when a short paragraph would be clearer
- Use five sentences where two will do
- Repeat the same point in slightly different language
- confuse “worked on” with “completed,” “launched,” or “shipped”
Avoid phrases such as:
- “I hope this message finds you well”
- “Exciting opportunity”
- “Game-changing”
- “Best-in-class”
- “Unlock value”
- “Drive synergies”
- “At the intersection of” unless it is literally useful
- “Not just X, but Y”
- “This isn’t about X—it’s about Y”
- “We’re thrilled to announce”
Editing method
Before rewriting, determine:
What is the author actually trying to communicate?
What does the recipient need to understand?
Is there a decision, ask, or next step?
What context is essential?
What can be removed without losing meaning?
How formal should the message be based on the recipient and channel?
Then rewrite the message so it is:
- Clearer
- Shorter where possible
- More cohesive
- More objective
- Natural to say aloud
- Faithful to the author’s intended meaning
Do not make material strategic changes unless asked.
If the source draft is ambiguous, preserve the likely meaning and flag only ambiguities that could materially change the message.
Contrastive examples
Too corporate:
“Following our recent discussions, I would like to schedule time to ensure alignment across our go-to-market strategy, organizational capabilities, and broader strategic priorities.”
The author’s voice:
“I’d like to use the time to realign on our GTM strategy, internal capacity, and broader priorities.”
Too vague:
“We’ve been making exciting progress across several key initiatives.”
The author’s voice:
“We’ve made progress on the first event, the hiring pipeline, and the training platform. The next step is turning that work into a clear operating plan.”
Too polished:
“Our objective is to create a differentiated ecosystem that brings together technical and creative stakeholders.”
The author’s voice:
“We’re bringing engineers, artists, musicians, and designers into the same room to build together.”
Too deferential:
“I completely agree with your perspective and would be happy to follow whichever direction you believe is best.”
The author’s voice:
“My head is trending in a similar direction. I’m supportive of this approach, but I’d like to think about it more holistically.”
Too abrupt:
“Send the contract today.”
The author’s voice:
“Could you send the contract over today? I’d like to get it moving before the end of the week.”
Output expectations
Unless asked otherwise:
- Return one polished version
- Do not explain every edit
- Do not add a long preamble
- Preserve names, dates, links, numbers, and commitments
- Match the original format: Slack message, email, memo, proposal, or social post
- Keep short messages short
- Use bullets only when they materially improve scanning
- Make the ask or next step unmistakable
Final test: The result should sound like the author on a clear-headed day—not like an AI imitating a CEO.

The input is a message the author has drafted. Rewrite that draft — you are re-voicing their message, NEVER replying to it. Preserve every fact and keep names, acronyms, and technical terms exactly as written (never expand an acronym). Do not add or remove information, and never include notes or commentary about the draft. Return ONLY the rewritten text with no preamble, quotes, or explanation.

NON-NEGOTIABLE: if the draft asks a question, your rewrite MUST still be a question ending in a question mark, asking the recipient the same thing — never answer it, never decide it, and never turn it into a statement.`;

const PROMPT_FILE =
  process.env.REWRITE_PROMPT_FILE ||
  path.join(CONFIG_DIR, "prompt.txt");
const STYLES_DIR =
  process.env.REWRITE_STYLES_DIR ||
  path.join(CONFIG_DIR, "styles");

function loadPrompt(style) {
  if (style) {
    if (!/^[A-Za-z0-9_-]+$/.test(style)) {
      console.error(`revoice: invalid style name "${style}" (letters, digits, - and _ only)`);
      process.exit(1);
    }
    try {
      const p = fs.readFileSync(path.join(STYLES_DIR, `${style}.txt`), "utf8").trim();
      if (p) return p;
    } catch {}
    if (BUILTIN_STYLES[style]) return BUILTIN_STYLES[style] + "\n\n" + PROMPT_RULES;
    console.error(
      `revoice: unknown style "${style}" (no ${path.join(STYLES_DIR, style + ".txt")}; built-ins: ${Object.keys(BUILTIN_STYLES).join("|")})`
    );
    process.exit(1);
  }
  try {
    const p = fs.readFileSync(PROMPT_FILE, "utf8").trim();
    if (p) return p;
  } catch {}
  return DEFAULT_PROMPT;
}

let ACTIVE_STYLE = "";

// Few-shot voice examples: paste samples of your real writing, separated by
// lines of --- ; rewrites imitate their style (not their content).
const VOICE_SAMPLES_FILE =
  process.env.VOICE_SAMPLES_FILE ||
  path.join(CONFIG_DIR, "voice-samples.txt");
const parsedVoiceChars = Number(process.env.VOICE_MAX_CHARS);
const VOICE_MAX_CHARS =
  Number.isFinite(parsedVoiceChars) && parsedVoiceChars > 0 ? parsedVoiceChars : 6000;

function loadVoiceSamples() {
  try {
    const raw = fs.readFileSync(VOICE_SAMPLES_FILE, "utf8").trim();
    if (!raw) return [];
    const samples = raw
      .split(/\n---+\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    let used = 0;
    for (const s of samples) {
      if (used + s.length > VOICE_MAX_CHARS) break;
      out.push(s);
      used += s.length;
    }
    return out;
  } catch {
    return [];
  }
}

// Agent skills: Markdown rule files appended to every promptable rewrite.
// Drop any SKILL.md-style file into the skills dir; YAML frontmatter is stripped.
const SKILLS_DIR =
  process.env.REWRITE_SKILLS_DIR ||
  path.join(CONFIG_DIR, "skills");
const parsedSkillChars = Number(process.env.SKILLS_MAX_CHARS);
const SKILLS_MAX_CHARS =
  Number.isFinite(parsedSkillChars) && parsedSkillChars > 0 ? parsedSkillChars : 16000;

function loadSkills() {
  let files;
  try {
    files = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  const out = [];
  let used = 0;
  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(SKILLS_DIR, f), "utf8");
    } catch {
      continue;
    }
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    if (!body) continue;
    if (used + body.length > SKILLS_MAX_CHARS) {
      console.error(
        `revoice: skipping skill ${f} (would exceed SKILLS_MAX_CHARS=${SKILLS_MAX_CHARS})`
      );
      continue;
    }
    out.push({ name: f.replace(/\.md$/, ""), body });
    used += body.length;
  }
  return out;
}

// Rewrite history (JSONL) powering the menu bar recents and the learning loop.
const HISTORY_FILE =
  process.env.REWRITE_HISTORY_FILE ||
  path.join(CONFIG_DIR, "history.jsonl");
const HISTORY_MAX_ENTRIES = 200;

function readHistory() {
  try {
    return fs
      .readFileSync(HISTORY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(
    HISTORY_FILE,
    entries.slice(-HISTORY_MAX_ENTRIES).map((e) => JSON.stringify(e)).join("\n") + "\n",
    { mode: 0o600 }
  );
}

function appendHistory(entry) {
  try {
    // append (never clobbers a concurrent writer), then trim if oversized
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
    const entries = readHistory();
    if (entries.length > HISTORY_MAX_ENTRIES) writeHistory(entries);
  } catch {}
}

function markLastHistory(outcome) {
  const entries = readHistory();
  if (!entries.length) return false;
  entries[entries.length - 1].outcome = outcome;
  writeHistory(entries);
  return true;
}

// Learning loop: recently rejected rewrites become negative examples so the
// model stops repeating the patterns the author keeps throwing away.
const parsedRejectedMax = Number(process.env.REJECTED_EXAMPLES_MAX);
const REJECTED_EXAMPLES_MAX =
  Number.isFinite(parsedRejectedMax) && parsedRejectedMax >= 0 ? parsedRejectedMax : 3;

function loadRejectedExamples() {
  if (REJECTED_EXAMPLES_MAX === 0) return [];
  return readHistory()
    .filter((e) => e.outcome === "rejected" && e.rewrite)
    .slice(-REJECTED_EXAMPLES_MAX);
}

// Reply mode: the user message is a self-contained brief instead of a draft.
function buildReplyBrief(notes, context, hasImage) {
  let b =
    "REPLY MODE (this overrides any rule above about never replying): draft the " +
    "author's reply to a conversation. Do not rewrite the notes below; use them " +
    "(and the conversation) to write what the author would send next. Keep the " +
    "author's voice rules, and never invent facts, dates, or commitments the notes don't give.";
  if (hasImage)
    b +=
      "\nThe attached screenshot shows the conversation the author is replying to. " +
      "Read it carefully — the author is the person about to send the next message.";
  if (context)
    b += "\n\nCONVERSATION CONTEXT (what the author is replying to):\n" + context;
  b += notes
    ? "\n\nWHAT THE AUTHOR WANTS TO SAY (rough notes):\n" + notes
    : "\n\nWHAT THE AUTHOR WANTS TO SAY: no notes given — infer the natural, useful reply from the conversation.";
  b +=
    "\n\nOutput only the reply, ready to send, in the author's voice, matching the " +
    "channel's format (chat → short; email → a little more structure). No preamble, " +
    "no quotes, no explanation.";
  return b;
}

// What the model is asked to do with `text`. CLI backends (claude/codex) get
// it appended to the system prompt; API backends (kimi/ollama) get it as the
// user message, where a plain rewrite is just the draft itself.
function buildTaskMessage(text, task) {
  if (task.reply) return buildReplyBrief(text, task.context, task.images.length > 0);
  return "DRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + text;
}
function buildUserMessage(text, task) {
  return task.reply ? buildTaskMessage(text, task) : text;
}

function imageDataUrl(file) {
  const ext = path.extname(file).toLowerCase().replace(".", "");
  const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

function buildSystemPrompt(instruction) {
  let prompt = loadPrompt(ACTIVE_STYLE);
  for (const s of loadSkills()) {
    prompt += `\n\nSKILL "${s.name}" — apply these rules strictly and silently to the rewrite (never mention them):\n${s.body}`;
  }
  const rejected = loadRejectedExamples();
  if (rejected.length) {
    prompt +=
      "\n\nThe author rejected these earlier rewrites. Do NOT produce rewrites " +
      "with the same tone, structure, or phrasing patterns as these (they are " +
      "examples of what the author does not want):";
    rejected.forEach((e, i) => {
      prompt += `\n\nREJECTED REWRITE ${i + 1}:\n${String(e.rewrite).slice(0, 600)}`;
    });
  }
  const samples = loadVoiceSamples();
  if (samples.length) {
    prompt +=
      "\n\nWrite the rewrite in the author's own voice. Match the sentence " +
      "length, rhythm, vocabulary, connectors, and punctuation style of these " +
      "examples of the author's real writing (imitate the style, NOT the content):";
    samples.forEach((s, i) => {
      prompt += `\n\nEXAMPLE ${i + 1}:\n${s}`;
    });
  }
  if (instruction) prompt += `\n\nAdditional instruction: ${instruction}`;
  return prompt;
}

const KIMI_API_URL = (process.env.KIMI_API_URL || "https://api.moonshot.ai/v1").replace(/\/$/, "");
const KIMI_API_KEY = process.env.KIMI_API_KEY || "";
const KIMI_MODEL = process.env.KIMI_MODEL || "moonshot-v1-auto";
const rawKimiTemp = (process.env.KIMI_TEMPERATURE || "").trim();
const parsedKimiTemp = rawKimiTemp === "" ? NaN : Number(rawKimiTemp);
// no default: kimi-k* models only accept the provider default temperature
const KIMI_TEMPERATURE = Number.isFinite(parsedKimiTemp) ? parsedKimiTemp : null;
if (rawKimiTemp !== "" && KIMI_TEMPERATURE === null)
  console.error(`revoice: ignoring invalid KIMI_TEMPERATURE "${rawKimiTemp}"`);

function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN))
    return process.env.CLAUDE_BIN;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "claude");
    try {
      if (fs.statSync(p).isFile()) {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch {}
  }
  return null;
}

function rewriteWithClaude(text, instruction, ms, task) {
  const bin = findClaude();
  if (!bin) return Promise.reject(new Error("claude CLI not found (npm i -g @anthropic-ai/claude-code)"));
  let prompt = buildSystemPrompt(instruction) + "\n\n" + buildTaskMessage(text, task);
  if (task.images.length) {
    prompt +=
      "\n\nScreenshot file(s) of the conversation — read each with your Read tool before drafting:\n" +
      task.images.join("\n");
  }
  const args = ["-p", prompt];
  if (task.images.length) args.push("--allowedTools", "Read");
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${ms}ms`));
    }, ms);
    timer.unref();
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = out.trim();
      if (code === 0 && result) resolve(result);
      else reject(new Error(`claude exited ${code}: ${err.trim() || "empty output"}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

const CODEX_MODEL = (process.env.CODEX_MODEL || "gpt-6-astra").trim();
const CODEX_REASONING_EFFORT = (process.env.CODEX_REASONING_EFFORT || "low").trim();

function findCodex() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN))
    return process.env.CODEX_BIN;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "codex");
    try {
      if (fs.statSync(p).isFile()) {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch {}
  }
  return null;
}

// Codex CLI (`codex exec`) — non-interactive run through the user's ChatGPT
// subscription. The final assistant message is written to a temp file via
// --output-last-message so progress noise on stdout never leaks into the paste.
function rewriteWithCodex(text, instruction, ms, task) {
  const bin = findCodex();
  if (!bin) return Promise.reject(new Error("codex CLI not found (npm i -g @openai/codex)"));
  const prompt = buildSystemPrompt(instruction) + "\n\n" + buildTaskMessage(text, task);
  const outFile = path.join(
    os.tmpdir(),
    `revoice-codex-${process.pid}-${Date.now()}.txt`
  );
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox", "read-only",
    "--color", "never",
    "--output-last-message", outFile,
  ];
  if (CODEX_MODEL) args.push("--model", CODEX_MODEL);
  if (CODEX_REASONING_EFFORT)
    args.push("-c", `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`);
  for (const img of task.images) args.push("--image", img);
  args.push(prompt);
  return new Promise((resolve, reject) => {
    // stdin must be closed: codex appends piped stdin to the prompt.
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: os.tmpdir(),
    });
    let out = "", err = "";
    const cleanup = () => {
      try { fs.unlinkSync(outFile); } catch {}
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`codex timed out after ${ms}ms`));
    }, ms);
    timer.unref();
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); cleanup(); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = "";
      try { result = fs.readFileSync(outFile, "utf8").trim(); } catch {}
      cleanup();
      if (!result) result = out.trim();
      if (code === 0 && result) resolve(result);
      else reject(new Error(`codex exited ${code}: ${codexErrorSummary(err)}`));
    });
  });
}

// codex exec logs verbose INFO/WARN tracing to stderr; keep only the last ERROR line.
function codexErrorSummary(stderr) {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /^ERROR:/.test(l));
  const pick = errs.length ? errs[errs.length - 1] : lines.filter((l) => !/ (INFO|WARN) /.test(l)).pop();
  return (pick || "empty output").slice(0, 300);
}

async function rewriteWithKimi(text, instruction, onChunk, task) {
  if (!KIMI_API_KEY) throw new Error("KIMI_API_KEY not set");
  const system = buildSystemPrompt(instruction);
  const url = `${KIMI_API_URL}/chat/completions`;
  const userText = buildUserMessage(text, task);
  // OpenAI vision format: content becomes an array of parts when images are attached
  const userContent = task.images.length
    ? [
        { type: "text", text: userText },
        ...task.images.map((f) => ({ type: "image_url", image_url: { url: imageDataUrl(f) } })),
      ]
    : userText;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        ...(onChunk && { stream: true }),
        ...(KIMI_TEMPERATURE !== null && { temperature: KIMI_TEMPERATURE }),
      }),
    });
  } catch (e) {
    throw new Error(`Kimi request to ${url} failed: ${e?.cause?.code || e.message}`);
  }
  if (!res.ok) throw new Error(`Kimi API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (onChunk) {
    // OpenAI-compatible SSE stream: `data: {json}` lines, ends with [DONE]
    let full = "", buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m || m[1] === "[DONE]") continue;
        try {
          const delta = JSON.parse(m[1])?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        } catch {}
      }
    }
    // flush a trailing line the provider didn't newline-terminate
    const m = buf.match(/^data:\s*(.*)$/);
    if (m && m[1] !== "[DONE]") {
      try {
        const delta = JSON.parse(m[1])?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch {}
    }
    const out = full.trim();
    if (!out) throw new Error("Kimi returned empty result");
    return out;
  }
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("Kimi returned empty result");
  return out;
}

const BACKENDS = ["claude", "codex", "kimi", "ollama"];
const DEFAULT_CHAIN = BACKENDS;

// Resolve `--backend` (or REWRITE_BACKEND when --backend is omitted) into an
// ordered list. "auto" expands to the default chain; a single explicit
// backend fails hard instead of falling through.
function resolveChain(spec) {
  const raw = (spec || "auto").trim();
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const chain = [];
  for (const p of parts) {
    if (p === "auto") {
      for (const b of DEFAULT_CHAIN) if (!chain.includes(b)) chain.push(b);
    } else if (!chain.includes(p)) chain.push(p);
  }
  const explicit = parts.length === 1 && parts[0] !== "auto";
  return { chain, explicit };
}

function parseArgs(argv) {
  const args = { backend: null, instruction: "", style: "", stream: false, logHistory: false, reply: false, context: "", images: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stream") args.stream = true;
    else if (a === "--log-history") args.logHistory = true;
    else if (a === "--reply") args.reply = true;
    else if (a === "--context") {
      args.context = argv[++i];
      if (args.context === undefined) {
        console.error("revoice: --context requires a value (the message you're replying to)");
        process.exit(1);
      }
    } else if (a === "--image") {
      const f = argv[++i];
      if (f === undefined) {
        console.error("revoice: --image requires a file path");
        process.exit(1);
      }
      if (!fs.existsSync(f)) {
        console.error(`revoice: --image file not found: ${f}`);
        process.exit(1);
      }
      args.images.push(path.resolve(f));
    }
    else if (a === "--history") {
      const entries = readHistory().slice(-20).reverse();
      for (const e of entries) console.log(JSON.stringify(e));
      process.exit(0);
    } else if (a === "--mark-last") {
      const outcome = argv[++i];
      if (!outcome || !/^[a-z-]+$/.test(outcome)) {
        console.error("revoice: --mark-last requires an outcome (accepted|rejected)");
        process.exit(1);
      }
      process.exit(markLastHistory(outcome) ? 0 : 1);
    }
    else if (a === "--backend") {
      args.backend = argv[++i];
      if (args.backend === undefined) {
        console.error(`revoice: --backend requires a value (use auto|${BACKENDS.join("|")} or a comma-separated chain)`);
        process.exit(1);
      }
      for (const b of args.backend.split(",")) {
        if (b !== "auto" && !BACKENDS.includes(b)) {
          console.error(`revoice: invalid --backend "${args.backend}" (use auto|${BACKENDS.join("|")} or a comma-separated chain)`);
          process.exit(1);
        }
      }
    } else if (a === "--instruction" || a === "-i") {
      args.instruction = argv[++i];
      if (args.instruction === undefined) {
        console.error("revoice: --instruction requires a value");
        process.exit(1);
      }
    } else if (a === "--print-default-prompt") {
      // used by install.sh so the shipped prompt files never drift from the CLI
      console.log(DEFAULT_PROMPT);
      process.exit(0);
    } else if (a === "--print-style-prompt") {
      const name = argv[++i];
      if (!name || !BUILTIN_STYLES[name]) {
        console.error(`revoice: --print-style-prompt requires one of: ${Object.keys(BUILTIN_STYLES).join("|")}`);
        process.exit(1);
      }
      console.log(BUILTIN_STYLES[name] + "\n\n" + PROMPT_RULES);
      process.exit(0);
    } else if (a === "--skills") {
      const skills = loadSkills();
      if (!skills.length) console.log(`No skills loaded (put .md files in ${SKILLS_DIR})`);
      else for (const s of skills) console.log(`${s.name}  (${s.body.length} chars)`);
      process.exit(0);
    } else if (a === "--style" || a === "-s") {
      args.style = argv[++i];
      if (args.style === undefined) {
        console.error("revoice: --style requires a value");
        process.exit(1);
      }
    }
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: echo TEXT | revoice [--backend auto|claude|codex|kimi|ollama|CHAIN] [--instruction TEXT] [--style founder|casual|professional|concise|NAME] [--stream] [--log-history] [--history] [--mark-last accepted|rejected] [--skills]\n" +
        "       echo NOTES | revoice --reply [--context TEXT] [--image FILE]...   (draft a reply in your voice; NOTES may be empty)"
      );
      process.exit(0);
    } else {
      console.error(`revoice: unknown argument "${a}" (see --help)`);
      process.exit(1);
    }
  }
  return args;
}

function readStdin() {
  if (process.stdin.isTTY) {
    console.error("revoice: pipe text on stdin, e.g. echo TEXT | revoice");
    process.exit(1);
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function rewriteWithOllama(text, instruction, onChunk, task) {
  const user = { role: "user", content: buildUserMessage(text, task) };
  // Ollama vision models take raw base64 (no data: prefix)
  if (task.images.length)
    user.images = task.images.map((f) => fs.readFileSync(f).toString("base64"));
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: Boolean(onChunk),
      options: { num_ctx: OLLAMA_NUM_CTX },
      messages: [
        { role: "system", content: buildSystemPrompt(instruction) },
        user,
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  if (onChunk) {
    // NDJSON stream: one JSON object per line with message.content deltas
    let full = "", buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const delta = JSON.parse(line)?.message?.content;
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        } catch {}
      }
    }
    if (buf.trim()) {
      try {
        const delta = JSON.parse(buf)?.message?.content;
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch {}
    }
    const out = full.trim();
    if (!out) throw new Error("Ollama returned empty result");
    return out;
  }
  const data = await res.json();
  const out = (data?.message?.content || "").trim();
  if (!out) throw new Error("Ollama returned empty result");
  return out;
}

function withTimeout(promise, ms, label, onTimeout) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        if (onTimeout) onTimeout();
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms).unref()
    ),
  ]);
}

async function main() {
  const args = parseArgs(process.argv);
  ACTIVE_STYLE = args.style;
  if (args.style) loadPrompt(args.style); // validate the style up front

  const text = (await readStdin()).trim();
  const task = { reply: args.reply, context: args.context.trim(), images: args.images };
  if (!task.reply && (task.context || task.images.length)) {
    console.error("revoice: --context/--image only apply with --reply");
    process.exit(1);
  }
  if (!text && !task.reply) {
    console.error("revoice: no input text on stdin");
    process.exit(1);
  }
  if (!text && !task.context && !task.images.length) {
    console.error("revoice: reply mode needs notes on stdin, --context, or --image");
    process.exit(1);
  }

  const deadline = Date.now() + REWRITE_TIMEOUT_MS;
  const errors = [];
  // In --stream mode Kimi/Ollama chunks are written to stdout as they arrive;
  // emit() then only needs to flush whatever wasn't already streamed.
  let streamedChars = 0;
  const onChunk = args.stream
    ? (delta) => {
        streamedChars += delta.length;
        process.stdout.write(delta);
      }
    : null;
  const emit = (out, via) => {
    if (via) console.error(`via:${via}`);
    if (args.logHistory) {
      appendHistory({
        ts: new Date().toISOString(),
        original: (text || task.context).slice(0, 2000),
        rewrite: out.slice(0, 2000),
        style: args.style || "",
        instruction: args.instruction || "",
        ...(task.reply && { mode: "reply", images: task.images.length }),
        via,
      });
    }
    const rest = streamedChars > 0 ? "" : out;
    process.stdout.write(rest, () => process.exit(0));
  };
  const remaining = (min) => Math.max(deadline - Date.now(), min);
  const cliBudget = (envName) => {
    const parsed = Number(process.env[envName]);
    return Math.min(remaining(10000), Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity);
  };

  const spec = args.backend !== null ? args.backend : process.env.REWRITE_BACKEND;
  const { chain, explicit } = resolveChain(spec);
  if (args.backend === null) {
    for (const b of chain) {
      if (!BACKENDS.includes(b)) {
        console.error(`revoice: invalid REWRITE_BACKEND "${spec}" (use auto|${BACKENDS.join("|")} or a comma-separated chain)`);
        process.exit(1);
      }
    }
  }

  const runners = {
    claude: () => rewriteWithClaude(text, args.instruction, cliBudget("CLAUDE_TIMEOUT_MS"), task),
    codex: () => rewriteWithCodex(text, args.instruction, cliBudget("CODEX_TIMEOUT_MS"), task),
    kimi: () => withTimeout(rewriteWithKimi(text, args.instruction, onChunk, task), remaining(10000), "Kimi"),
    ollama: () => withTimeout(rewriteWithOllama(text, args.instruction, onChunk, task), remaining(10000), "Ollama"),
  };

  for (const backend of chain) {
    // Kimi only joins an automatic chain when it's actually configured.
    if (backend === "kimi" && !KIMI_API_KEY && !explicit) continue;
    try {
      emit(await runners[backend](), backend);
      return;
    } catch (e) {
      errors.push(`${backend}: ${e.message}`);
      // once partial output has been streamed, falling back would corrupt stdout
      if (explicit || streamedChars > 0) {
        console.error(errors.join("; "));
        process.exit(1);
      }
    }
  }
  console.error("revoice failed — " + (errors.join("; ") || "no backend available"));
  process.exit(1);
}

main().catch((e) => {
  console.error("revoice: " + (e?.message || e));
  process.exit(1);
});
