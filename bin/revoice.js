#!/usr/bin/env node
/**
 * revoice — rewrite text from stdin and print the result to stdout.
 *
 * Backend order (auto):
 *   1. Claude Code CLI (your Claude subscription, fully promptable)
 *   2. Codex CLI (your ChatGPT subscription; default model gpt-6-astra)
 *   3. OpenAI API (paid per token, if OPENAI_API_KEY is set; default gpt-6-astra, streams)
 *   4. Kimi / any OpenAI-compatible API (if KIMI_API_KEY is set)
 *   5. Ollama (local model, default: llama3.2:3b)
 *
 * Reorder or restrict the chain with REWRITE_BACKEND, e.g.
 *   REWRITE_BACKEND=codex,claude,kimi,ollama   (Astra first)
 *   REWRITE_BACKEND=openai                     (API only: fast, streams, paid)
 *
 * The rewrite prompt is editable: ~/.revoice/prompt.txt
 * (or REWRITE_PROMPT_FILE).
 *
 * Usage:
 *   echo "some text" | revoice
 *   echo "some text" | revoice --instruction "make it shorter"
 *   echo "text" | revoice --backend claude|codex|openai|kimi|ollama
 *
 * Reply mode (draft a reply instead of rewriting): stdin is your rough notes
 * (may be empty), --context is the message you're replying to, --image is a
 * screenshot of the conversation (Codex/Astra reads it; OpenAI/Kimi/Ollama get it as
 * an image part, Claude gets the path to Read).
 *   echo "yes but not before friday" | revoice --reply --image thread.png
 *
 * Env vars:
 *   REWRITE_PROMPT_FILE (default ~/.revoice/prompt.txt)
 *   REWRITE_BACKEND  (default claude,codex,openai,kimi,ollama)
 *   CLAUDE_BIN, CLAUDE_MODEL, CLAUDE_TIMEOUT_MS
 *   CODEX_BIN, CODEX_MODEL (default gpt-6-astra), CODEX_REASONING_EFFORT (default low), CODEX_TIMEOUT_MS
 *   OPENAI_API_URL (default https://api.openai.com/v1), OPENAI_API_KEY, OPENAI_MODEL (default gpt-6-astra), OPENAI_REASONING_EFFORT (default low)
 *   KIMI_API_URL (default https://api.moonshot.ai/v1), KIMI_API_KEY, KIMI_MODEL, KIMI_TEMPERATURE
 *   OLLAMA_URL       (default http://127.0.0.1:11434)
 *   OLLAMA_MODEL     (default llama3.2:3b)
 *   OLLAMA_PROMPT    compact (default: short rewrite-only prompt small models can follow) | full
 *   REWRITE_TIMEOUT_MS (default 25000)
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_DIR = path.join(os.homedir(), ".revoice");

// Load ~/.revoice/env (KEY=VALUE lines) so settings like KIMI_API_KEY
// reach the CLI even when launched from Hammerspoon (no shell profile there).
// Real environment variables win over the file; within the file the last
// assignment of a key wins, so `echo KEY=v >> ~/.revoice/env` overrides.
try {
  const envFile = path.join(CONFIG_DIR, "env");
  const fromFile = {};
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v.match(/^(["'])([\s\S]*?)\1\s*(?:#.*)?$/);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, "").trim();
    fromFile[m[1]] = v;
  }
  for (const [k, v] of Object.entries(fromFile))
    if (process.env[k] === undefined) process.env[k] = v;
} catch {}

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const OLLAMA_PROMPT = process.env.OLLAMA_PROMPT === "full" ? "full" : "compact";
const parsedNumCtx = Number(process.env.OLLAMA_NUM_CTX);
const OLLAMA_NUM_CTX =
  Number.isFinite(parsedNumCtx) && parsedNumCtx > 0 ? parsedNumCtx : 8192;
const parsedTimeout = Number(process.env.REWRITE_TIMEOUT_MS);
const REWRITE_TIMEOUT_MS =
  Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 25000;
const ZO_TOKEN = process.env.REVOICE_ZO_TOKEN || process.env.ZO_API_TOKEN || "";
const ZO_URL = process.env.REVOICE_ZO_URL || "https://api.zo.computer/mcp";
const CONTEXT_DIR = path.join(CONFIG_DIR, "context");
const CONTEXT_DISABLED = process.env.REVOICE_CONTEXT === "off";
const CALENDAR_ACCOUNTS = (process.env.REVOICE_CALENDARS || "")
  .split(",")
  .map((account) => account.trim())
  .filter(Boolean);
const CONTEXT_TZ = process.env.REVOICE_TZ || "America/New_York";
const CONTEXT_WORK_HOURS = process.env.REVOICE_WORK_HOURS || "9-18";
const GOLDFISH_PATH =
  process.env.GOLDFISH_MCP ||
  (fs.existsSync("/Applications/Goldfish.app/Contents/MacOS/goldfish-mcp")
    ? "/Applications/Goldfish.app/Contents/MacOS/goldfish-mcp"
    : "");

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

const ZO_ALLOWED_TOOLS = new Set(["read_file", "list_directory", "use_app_google_calendar"]);
const ZO_CALENDAR_TOOLS = new Set([
  "google_calendar-query-free-busy-calendars",
  "google_calendar-list-events",
]);
let zoSessionPromise = null;
let zoRequestId = 0;

function zoResponsePayload(text, contentType) {
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    text = data[data.length - 1] || "";
  }
  if (!text) return {};
  return JSON.parse(text);
}

async function zoHttp(payload, sessionId, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ZO_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${ZO_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Zo HTTP ${response.status}: ${text.slice(0, 160)}`);
    return {
      payload: zoResponsePayload(text, response.headers.get("content-type")),
      sessionId: response.headers.get("mcp-session-id") || sessionId,
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Zo request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function zoSession() {
  if (!ZO_TOKEN) throw new Error("REVOICE_ZO_TOKEN is not set");
  if (!zoSessionPromise) {
    zoSessionPromise = (async () => {
      const initialized = await zoHttp({
        jsonrpc: "2.0",
        id: ++zoRequestId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "revoice", version: "1.0.0" },
        },
      });
      if (initialized.payload.error)
        throw new Error(initialized.payload.error.message || "Zo initialize failed");
      const sessionId = initialized.sessionId;
      await zoHttp(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId
      );
      return sessionId;
    })().catch((error) => {
      zoSessionPromise = null;
      throw error;
    });
  }
  return zoSessionPromise;
}

async function zoCall(tool, args = {}) {
  if (
    !ZO_ALLOWED_TOOLS.has(tool) ||
    (tool === "use_app_google_calendar" && !ZO_CALENDAR_TOOLS.has(args.tool_name))
  )
    throw new Error(`zo tool not allowed: ${tool}`);
  const sessionId = await zoSession();
  const response = await zoHttp(
    {
      jsonrpc: "2.0",
      id: ++zoRequestId,
      method: "tools/call",
      params: { name: tool, arguments: args },
    },
    sessionId
  );
  if (response.payload.error)
    throw new Error(response.payload.error.message || `Zo ${tool} failed`);
  const result = response.payload.result || {};
  if (result.isError)
    throw new Error(
      (result.content || []).map((part) => part.text || "").join("\n") || `Zo ${tool} failed`
    );
  let content = (result.content || []).map((part) => part.text || "").join("");
  if (tool === "read_file") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string"))
        content = parsed.join("");
    } catch {}
  }
  return content;
}

function readContextFile(name, cap, tail = false) {
  try {
    const body = fs.readFileSync(path.join(CONTEXT_DIR, name), "utf8");
    return tail ? body.slice(-cap) : body.slice(0, cap);
  } catch {
    return "";
  }
}

function localContextBlocks(mode) {
  if (CONTEXT_DISABLED) return [];
  const names = mode === "rewrite" ? ["about-me.md", "notes.md"] : ["about-me.md", "notes.md", "zoey.md"];
  return names
    .map((name) => ({
      source: name.replace(/\.md$/, ""),
      title: name.replace(/\.md$/, ""),
      body: readContextFile(name, name === "about-me.md" ? 3000 : name === "notes.md" ? 2000 : 4000, name === "notes.md"),
    }))
    .filter((block) => block.body.trim());
}

async function syncZoeyContext() {
  const body = await zoCall("read_file", { target_file: "/home/workspace/Records/Context/you.md" });
  if (!body.trim()) throw new Error("Zo returned an empty context card");
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTEXT_DIR, "zoey.md"), body, { mode: 0o600 });
  return body;
}

function sourceWarning(source, error) {
  const reason = String(error?.message || error || "unavailable").replace(/\s+/g, " ").slice(0, 180);
  console.error(`revoice: context ${source} skipped: ${reason}`);
}

function extractPeople(text) {
  const candidates = [];
  const seen = new Set();
  const add = (parts) => {
    if (parts.length < 2) return;
    const first = parts[0].replace(/[^a-z]/gi, "");
    const last = parts[1].replace(/[^a-z]/gi, "");
    if (!first || !last) return;
    const name = `${first} ${last}`;
    const slug = `${first}-${last}`.toLowerCase();
    if (seen.has(slug)) return;
    seen.add(slug);
    candidates.push({ name, slug });
  };
  for (const match of text.matchAll(/\b([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\s+([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\b/g))
    add([match[1], match[2]]);
  for (const match of text.matchAll(/\b([A-Z0-9._+-]+)@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    const parts = match[1].split(/[._-]+/).filter(Boolean);
    if (parts.length >= 2) add(parts);
  }
  return candidates.slice(0, 4);
}

function dateParts(epoch, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedEpoch(year, month, day, hour, minute, timeZone) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let epoch = wanted;
  for (let i = 0; i < 3; i++) {
    const parts = dateParts(epoch, timeZone);
    const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    const delta = wanted - represented;
    if (!delta) break;
    epoch += delta;
  }
  return epoch;
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

function parseBusyIntervals(raw) {
  const intervals = [];
  const expression = /['"]start['"]\s*:\s*['"]([^'"]+)['"]\s*,\s*['"]end['"]\s*:\s*['"]([^'"]+)['"]/g;
  for (const match of raw.matchAll(expression)) {
    const start = Date.parse(match[1]);
    const end = Date.parse(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) intervals.push([start, end]);
  }
  return intervals;
}

function formatAvailabilityTime(epoch, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    timeZoneName: "short",
  }).formatToParts(new Date(epoch));
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${p.weekday} ${p.month} ${p.day}`,
    hour: `${p.hour}:${p.minute}`,
    dayPeriod: p.dayPeriod,
    zone: p.timeZoneName,
  };
}

function computeFreeSlots({ now, busy = [], workHours = CONTEXT_WORK_HOURS, timeZone = CONTEXT_TZ }) {
  const hours = workHours.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!hours) throw new Error("REVOICE_WORK_HOURS must use H-H format");
  const startHour = Math.max(0, Math.min(23, Number(hours[1])));
  const endHour = Math.max(1, Math.min(24, Number(hours[2])));
  if (endHour <= startHour) throw new Error("REVOICE_WORK_HOURS end must be after start");
  const mergedBusy = mergeIntervals(busy);
  const today = dateParts(now, timeZone);
  const calendarDate = new Date(Date.UTC(+today.year, +today.month - 1, +today.day));
  const minuteNow = +today.hour * 60 + +today.minute + new Date(now).getSeconds() / 60;
  const nextBoundary = Math.floor(minuteNow / 30) * 30 + 30;
  const slots = [];
  for (let offset = 0; offset <= 7 && slots.length < 8; offset++) {
    const day = new Date(calendarDate.getTime() + offset * 86400000);
    const year = day.getUTCFullYear(), month = day.getUTCMonth() + 1, date = day.getUTCDate();
    const morning = zonedEpoch(year, month, date, startHour, 0, timeZone);
    const evening = zonedEpoch(year, month, date, endHour === 24 ? 0 : endHour, 0, timeZone) + (endHour === 24 ? 86400000 : 0);
    const dayName = dateParts(morning, timeZone).weekday;
    if (dayName === "Sat" || dayName === "Sun") continue;
    let cursor = morning;
    if (offset === 0) {
      const rounded = nextBoundary >= 1440
        ? zonedEpoch(year, month, date + 1, 0, 0, timeZone)
        : zonedEpoch(year, month, date, Math.floor(nextBoundary / 60), nextBoundary % 60, timeZone);
      cursor = Math.max(cursor, rounded);
    }
    for (const [busyStart, busyEnd] of mergedBusy) {
      if (busyEnd <= cursor || busyStart >= evening) continue;
      if (busyStart - cursor >= 30 * 60000) slots.push([cursor, Math.min(busyStart, evening)]);
      cursor = Math.max(cursor, busyEnd);
      if (cursor >= evening) break;
    }
    if (evening - cursor >= 30 * 60000) slots.push([cursor, evening]);
    if (slots.length >= 8) break;
  }
  return slots.slice(0, 8).map(([start, end]) => {
    const from = formatAvailabilityTime(start, timeZone);
    const to = formatAvailabilityTime(end, timeZone);
    const span = from.dayPeriod === to.dayPeriod
      ? `${from.hour}–${to.hour} ${to.dayPeriod}`
      : `${from.hour} ${from.dayPeriod}–${to.hour} ${to.dayPeriod}`;
    return `${from.date}, ${span} ${from.zone}`;
  });
}

function availabilityIsRelevant(text) {
  return /\b(meet|meeting|call|chat|schedule|availability|available|free|time works|calendar|book|sync|catch up|coffee|next week|tomorrow)\b/i.test(text);
}

async function gatherAvailability(text, windowStart) {
  const windowEnd = new Date(windowStart.getTime() + 7 * 86400000);
  const results = await Promise.all(
    CALENDAR_ACCOUNTS.map(async (account) => {
      try {
        const raw = await zoCall("use_app_google_calendar", {
          tool_name: "google_calendar-query-free-busy-calendars",
          email: account,
          configured_props: {
            calendarId: ["primary"],
            timeMin: windowStart.toISOString(),
            timeMax: windowEnd.toISOString(),
            timeZone: CONTEXT_TZ,
          },
        });
        return { account, intervals: parseBusyIntervals(raw) };
      } catch {
        return { account, intervals: [], failed: true };
      }
    })
  );
  const merged = mergeIntervals(results.flatMap((result) => result.intervals));
  const slots = computeFreeSlots({ now: windowStart.getTime(), busy: merged });
  const lines = slots.length ? slots : ["No free 30-minute slots found in the next seven days."];
  const failures = results.filter((result) => result.failed).map((result) => result.account);
  if (failures.length) lines.push(`availability may be incomplete: ${failures.join(", ")} unreachable`);
  return lines.join("\n");
}

function parseGoldfishText(result) {
  if (typeof result === "string") return result;
  if (result?.content) return result.content.map((part) => part.text || "").join("\n");
  return "";
}

async function searchGoldfish(query) {
  if (!GOLDFISH_PATH || !fs.existsSync(GOLDFISH_PATH)) return "";
  const child = spawn(GOLDFISH_PATH, [], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buffer = "";
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++zoRequestId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const response = JSON.parse(line);
        const entry = pending.get(response.id);
        if (!entry) continue;
        pending.delete(response.id);
        if (response.error) entry.reject(new Error(response.error.message || "Goldfish error"));
        else entry.resolve(response.result);
      } catch {}
    }
  });
  child.on("error", () => {});
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Goldfish timed out")), 3000).unref());
  try {
    const response = await Promise.race([
      (async () => {
        await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "revoice", version: "1.0.0" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const listed = await request("tools/list");
        const tools = listed?.tools || [];
        const tool = tools.find((candidate) =>
          /search|recall|recent|activity|context/i.test(candidate.name) &&
          !/delete|forget|write|update|set|add|remove|clear|record/i.test(candidate.name)
        );
        if (!tool) return "";
        const properties = tool.inputSchema?.properties || {};
        const key = Object.keys(properties).find((name) => /^(query|q|text|search)$/i.test(name)) ||
          (tool.inputSchema?.required || []).find((name) => properties[name]?.type === "string");
        if (!key) return "";
        const result = await request("tools/call", { name: tool.name, arguments: { [key]: query } });
        return parseGoldfishText(result).slice(0, 3000);
      })(),
      timeout,
    ]);
    return response || "";
  } catch (error) {
    throw error;
  } finally {
    child.kill("SIGTERM");
  }
}

function fitContextBlocks(blocks) {
  const priorities = ["goldfish", "contacts", "zoey", "about-me"];
  const size = () => blocks.reduce((sum, block) => sum + block.title.length + block.body.length + 8, 0);
  for (const source of priorities) {
    if (size() <= 12000) break;
    const matching = blocks.filter((block) => block.source === source);
    for (const block of matching) {
      const excess = size() - 12000;
      if (excess <= 0) break;
      block.body = block.body.slice(0, Math.max(0, block.body.length - excess));
    }
  }
  return blocks.filter((block) => block.body.trim());
}

async function gatherContext({ mode, text, context, windowTitle, app }) {
  const warnings = [];
  const warn = (source, error) => {
    const reason = String(error?.message || error || "unavailable").replace(/\s+/g, " ").slice(0, 180);
    warnings.push(`context ${source} skipped: ${reason}`);
    sourceWarning(source, error);
  };
  if (CONTEXT_DISABLED) return { blocks: [], warnings };
  const local = localContextBlocks(mode === "rewrite" ? "rewrite" : mode);
  if (mode === "rewrite") return { blocks: local, warnings };
  const queryText = [text, context, windowTitle].filter(Boolean).join("\n");
  const candidates = extractPeople(queryText);
  const now = process.env.REVOICE_NOW ? new Date(process.env.REVOICE_NOW) : new Date();
  const remoteJobs = [];
  const remoteLabels = [];
  if (ZO_TOKEN) {
    const cached = path.join(CONTEXT_DIR, "zoey.md");
    let stale = true;
    try { stale = Date.now() - fs.statSync(cached).mtimeMs > 24 * 60 * 60 * 1000; } catch {}
    if (stale) {
      remoteLabels.push("zoey");
      remoteJobs.push(
        (async () => {
          try {
            const body = await syncZoeyContext();
            return { source: "zoey-refresh", block: { source: "zoey", title: "Zoey context", body: body.slice(0, 4000) } };
          } catch (error) {
            warn("zoey", error);
            return { source: "zoey-refresh", failed: true };
          }
        })()
      );
    }
  }
  if (ZO_TOKEN) for (const candidate of candidates) {
    remoteLabels.push("contacts");
    remoteJobs.push(
      (async () => {
        try {
          const body = await zoCall("read_file", {
            target_file: `/home/workspace/Records/Contacts/${candidate.slug}.md`,
          });
          return body.trim()
            ? { source: "contacts", block: { source: "contacts", title: `Contact: ${candidate.name}`, body: body.slice(0, 1500) } }
            : { source: "contacts" };
        } catch (error) {
          if (!/not found|does not exist|no such file/i.test(error.message || "")) warn("contacts", error);
          return { source: "contacts", failed: true };
        }
      })()
    );
  }
  if (ZO_TOKEN && CALENDAR_ACCOUNTS.length && availabilityIsRelevant(queryText)) {
    remoteLabels.push("calendar");
    remoteJobs.push(
      (async () => {
        try {
          const body = await gatherAvailability(queryText, now);
          return { source: "availability", block: { source: "availability", title: "MY REAL AVAILABILITY (from my calendars; only offer these times)", body } };
        } catch (error) {
          warn("calendar", error);
          return { source: "availability", failed: true };
        }
      })()
    );
  }
  if (GOLDFISH_PATH) {
    remoteLabels.push("goldfish");
    remoteJobs.push(
      (async () => {
        const body = await searchGoldfish((windowTitle || [context, text].filter(Boolean).join("\n") || "").slice(0, 200));
        return body ? { source: "goldfish", block: { source: "goldfish", title: "RECENT SCREEN ACTIVITY (Goldfish)", body } } : { source: "goldfish" };
      })()
    );
  }
  const collected = [];
  const settledFlags = new Array(remoteJobs.length).fill(false);
  const settled = remoteJobs.map((job, index) =>
    job.then((result) => {
      settledFlags[index] = true;
      collected.push(result);
      return result;
    }).catch((error) => {
      settledFlags[index] = true;
      warn(remoteLabels[index], error);
      return { source: remoteLabels[index], failed: true };
    })
  );
  if (settled.length) {
    let timeoutId;
    await Promise.race([
      Promise.all(settled),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          const unresolved = remoteLabels.filter((_, index) => !settledFlags[index]);
          for (const source of unresolved) warn(source, "timed out after 6s context budget");
          resolve();
        }, 6000);
        timeoutId.unref();
      }),
    ]);
    clearTimeout(timeoutId);
  }
  const remote = collected;
  const refreshedZoey = remote.some((result) => result?.source === "zoey-refresh" && result.block);
  const blocks = local.filter((block) => block.source !== "zoey" || !refreshedZoey);
  let foundContacts = 0;
  for (const result of remote) {
    if (!result?.block) continue;
    if (result.block.source === "contacts" && foundContacts >= 3) continue;
    if (result.block.source === "contacts") foundContacts++;
    blocks.push(result.block);
  }
  return { blocks: fitContextBlocks(blocks), warnings };
}

async function contextStatus() {
  const lines = [];
  for (const name of ["about-me.md", "notes.md", "zoey.md"]) {
    const file = path.join(CONTEXT_DIR, name);
    try {
      const stat = fs.statSync(file);
      const size = fs.readFileSync(file, "utf8").length;
      const ageHours = Math.max(0, (Date.now() - stat.mtimeMs) / 3600000);
      lines.push(`${name}: ${size} chars, ${ageHours < 1 ? `${Math.round(ageHours * 60)}m` : `${Math.floor(ageHours)}h`} old`);
    } catch {
      lines.push(`${name}: missing`);
    }
  }
  let reachable = "not checked";
  if (ZO_TOKEN) {
    try {
      await zoCall("read_file", { target_file: "/home/workspace/Records/Context/you.md" });
      reachable = "reachable";
    } catch {
      reachable = "unreachable";
    }
  }
  lines.push(`zoey: token ${ZO_TOKEN ? "set" : "not set"}; ${reachable}`);
  lines.push(`calendars: ${CALENDAR_ACCOUNTS.length} accounts configured`);
  lines.push(`goldfish: ${GOLDFISH_PATH && fs.existsSync(GOLDFISH_PATH) ? GOLDFISH_PATH : "not found"}`);
  return lines;
}

// Reply mode: the user message is a self-contained brief instead of a draft.
function buildReplyBrief(notes, context, hasImage, task, contextBlocks) {
  let b =
    "REPLY MODE (this overrides any rule above about never replying): draft the " +
    "author's reply to a conversation. Do not rewrite the notes below; use them " +
    "(and the conversation) to write what the author would send next. Keep the " +
    "author's voice rules, and never invent facts, dates, or commitments the notes don't give.";
  if (task.app || task.windowTitle)
    b += `\nON SCREEN: ${[task.app, task.windowTitle].filter(Boolean).join(" — ")}`;
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
  if (contextBlocks.some((block) => block.source === "availability"))
    b += "\nIf the conversation is about meeting, propose 2–3 concrete times from MY REAL AVAILABILITY; never offer a time not listed.";
  return b;
}

// What the model is asked to do with `text`. CLI backends (claude/codex) get
// it appended to the system prompt; API backends (kimi/ollama) get it as the
// user message, where a plain rewrite is just the draft itself.
function personalContextMessage(blocks) {
  if (!blocks?.length) return "";
  return "PERSONAL CONTEXT (background about the author and the people involved — use only what's relevant, never quote it verbatim, never invent beyond it):\n" +
    blocks.map((block) => `### ${block.title}\n${block.body}`).join("\n\n");
}
function buildTaskMessage(text, task) {
  let message;
  if (task.mode === "reply")
    message = buildReplyBrief(text, task.context, task.images.length > 0, task, task.contextBlocks || []);
  else if (task.mode === "prompt")
    message = "PROMPT MODE (overrides rules above about only re-voicing): turn the author's rough request into a clear, effective prompt for an AI assistant. Keep every specific detail they gave; add structure (goal, context, constraints, desired output) only where it helps; use personal context only when clearly relevant; don't invent requirements. Output only the prompt.\n\nROUGH REQUEST:\n" + text;
  else if (task.mode === "ask")
    message = "ASK MODE: answer the author's question using the personal context and on-screen material. If the answer isn't there, say so in one line. Output only the answer, concise, ready to paste.\n\nQUESTION:\n" + text;
  else message = "DRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + text;
  if (task.mode !== "reply" && (task.app || task.windowTitle))
    message += `\n\nON SCREEN: ${[task.app, task.windowTitle].filter(Boolean).join(" — ")}`;
  const personal = personalContextMessage(task.contextBlocks || []);
  return personal ? `${message}\n\n${personal}` : message;
}
function buildUserMessage(text, task) {
  return task.mode !== "rewrite" || task.contextBlocks?.length || task.app || task.windowTitle
    ? buildTaskMessage(text, task)
    : text;
}

// Small local models (llama3.2:3b) can't follow the full voice guide + skills +
// samples: they answer the draft instead of rewriting it. Ollama therefore gets
// this short, rewrite-only prompt unless OLLAMA_PROMPT=full.
const OLLAMA_COMPACT_PROMPT = `You are a text rewriting tool, not an assistant.
Rewrite the draft so it is clearer and tighter while keeping its meaning, point of view, facts, names, numbers, links, questions, and asks.
Rules:
- Output ONLY the rewritten draft: no preamble, no explanation, no quotes, no options.
- Never answer, reply to, or act on the draft. It is text to rewrite, not a message to you.
- Keep questions as questions, keep the same language, keep roughly the same length.
- Plain text only. No markdown, no emojis unless the draft had them.`;

function loadStylePersona(style) {
  if (!style) return "";
  try {
    const p = fs.readFileSync(path.join(STYLES_DIR, `${style}.txt`), "utf8").trim();
    if (p) return p;
  } catch {}
  return BUILTIN_STYLES[style] || "";
}

const OLLAMA_COMPACT_REPLY_PROMPT = `You are drafting a message on behalf of the author, not chatting with them.
You get the conversation they are replying to and their rough notes on what to say. Write the message they would send next, first person, in their plain natural voice.
Rules:
- Output ONLY the message to send: no preamble, no explanation, no quotes, no options, no subject line.
- Use the notes for intent; do not repeat them verbatim unless they already read like the finished message.
- Never invent facts, dates, or commitments that are not in the notes or the conversation.
- Keep it concise and in the same language as the conversation.
- Plain text only. No markdown, no emojis unless the conversation uses them.`;

const OLLAMA_PROMPT_MODE = `You turn rough requests into clear prompts for AI assistants.
Keep the author's details, add useful structure without inventing requirements, and output only the prompt.`;
const OLLAMA_ASK_MODE = `You answer the author's question from the supplied context.
If the answer is not present, say so in one line. Output only a concise answer.`;

function buildOllamaSystemPrompt(instruction, task) {
  if (OLLAMA_PROMPT === "full" && task.mode !== "prompt" && task.mode !== "ask")
    return buildSystemPrompt(instruction, task);
  let prompt = task.mode === "reply" ? OLLAMA_COMPACT_REPLY_PROMPT
    : task.mode === "prompt" ? OLLAMA_PROMPT_MODE
      : task.mode === "ask" ? OLLAMA_ASK_MODE
        : OLLAMA_COMPACT_PROMPT;
  const persona = task.mode === "rewrite" || task.mode === "reply"
    ? loadStylePersona(ACTIVE_STYLE).slice(0, 800)
    : "";
  if (persona) prompt += `\n\nStyle for the rewrite: ${persona}`;
  if (instruction) prompt += `\n\nAdditional instruction: ${instruction}`;
  return prompt;
}

const normalizeText = (s) => s.toLowerCase().replace(/[\s"'“”‘’]+/g, " ").trim();

const OLLAMA_PREAMBLE = /^here(?:'s| is)(?: the| a| your)?(?: rewritten| revised| rewrite| version| draft| reply)[^\n]*:\s*/i;

// Strip the chatty wrapping small models add, then refuse an unchanged draft
// so a non-rewrite never gets pasted as if it were one. Applied to the whole
// response, which is why Ollama is never streamed to stdout.
function cleanOllamaOutput(out, text, task) {
  let o = out.trim();
  if (!OLLAMA_PREAMBLE.test(text)) o = o.replace(OLLAMA_PREAMBLE, "");
  if (/^["“][^"“”]*["”]$/s.test(o) && !/^["“]/.test(text)) o = o.slice(1, -1).trim();
  if (!o) throw new Error("Ollama returned empty result");
  if (task.mode === "rewrite" && normalizeText(splitFlags(o, text).rewrite) === normalizeText(text))
    throw new Error(`Ollama (${OLLAMA_MODEL}) returned the draft unchanged`);
  return o;
}

function imageDataUrl(file) {
  const ext = path.extname(file).toLowerCase().replace(".", "");
  const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

// Ambiguity flags: the model appends one `FLAGS:` line after the rewrite (only when the draft
// could be read two ways); the CLI strips it from stdout and reports each flag on stderr as
// `flag:<text>` so the preview can show them as chips without touching what gets pasted.
const FLAGS_INSTRUCTION =
  "\n\nAfter the rewrite, if — and only if — the draft contains an ambiguity that could " +
  "materially change its meaning (who, what, when, how much), add ONE final line in exactly " +
  "this form, each ambiguity as a short phrase:\nFLAGS: <ambiguity> | <ambiguity>\n" +
  "If nothing could change the meaning, add nothing after the rewrite.";
const FLAGS_LINE = /^\s*FLAGS?\s*:\s*(.*)$/i;
// A partial line that could still turn into a FLAGS_LINE match
const FLAGS_PREFIX = /^\s*(?:F|FL|FLA|FLAG|FLAGS)?\s*$/i;
// If the draft itself has a `Flags:` line, the model is preserving content, not flagging.
const draftHasFlagsLine = (draft) => (draft || "").split("\n").some((l) => FLAGS_LINE.test(l));

function splitFlags(out, draft) {
  if (draftHasFlagsLine(draft)) return { rewrite: out, flags: [] };
  const lines = out.split("\n");
  const i = lines.findLastIndex((l) => FLAGS_LINE.test(l));
  if (i < 0) return { rewrite: out, flags: [] };
  const tail = [lines[i].match(FLAGS_LINE)[1], ...lines.slice(i + 1)].join("\n");
  const flags = tail
    .split(/\s*\|\s*|\n\s*[-•*]\s+|\n+/)
    .map((f) => f.trim())
    .filter((f) => f && !/^(none|n\/a|no flags?)\.?$/i.test(f));
  return { rewrite: lines.slice(0, i).join("\n").trimEnd(), flags };
}

function buildSystemPrompt(instruction, task) {
  if (task?.mode === "prompt" || task?.mode === "ask") {
    let prompt = "You are Revoice. Follow the user's task exactly and output only the requested result.";
    if (instruction) prompt += `\n\nAdditional instruction: ${instruction}`;
    return prompt;
  }
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
  prompt += FLAGS_INSTRUCTION;
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

// Native OpenAI API (paid per token) — the fast, streaming alternative to the
// Codex CLI, which uses the ChatGPT subscription but can't stream.
const OPENAI_API_URL = (process.env.OPENAI_API_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6-astra";
// "off" omits the field entirely (for OPENAI_MODEL set to a non-reasoning model).
const OPENAI_REASONING_EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
const rawOpenaiEffort = (process.env.OPENAI_REASONING_EFFORT ?? "low").trim().toLowerCase();
const OPENAI_REASONING_EFFORT = OPENAI_REASONING_EFFORTS.includes(rawOpenaiEffort) ? rawOpenaiEffort : "low";
if (rawOpenaiEffort !== OPENAI_REASONING_EFFORT)
  console.error(`revoice: ignoring invalid OPENAI_REASONING_EFFORT "${rawOpenaiEffort}" (use ${OPENAI_REASONING_EFFORTS.join("|")})`);

const KIMI_PROVIDER = {
  name: "Kimi", keyVar: "KIMI_API_KEY", url: KIMI_API_URL, key: KIMI_API_KEY, model: KIMI_MODEL,
  extra: () => (KIMI_TEMPERATURE !== null ? { temperature: KIMI_TEMPERATURE } : {}),
};
const OPENAI_PROVIDER = {
  name: "OpenAI", keyVar: "OPENAI_API_KEY", url: OPENAI_API_URL, key: OPENAI_API_KEY, model: OPENAI_MODEL,
  extra: () => (OPENAI_REASONING_EFFORT === "off" ? {} : { reasoning_effort: OPENAI_REASONING_EFFORT }),
};

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
  let prompt = buildSystemPrompt(instruction, task) + "\n\n" + buildTaskMessage(text, task);
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
  const prompt = buildSystemPrompt(instruction, task) + "\n\n" + buildTaskMessage(text, task);
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
  // `--image <FILE>...` is greedy in codex's clap parser and would swallow the
  // prompt positional; the `--image=FILE` form binds exactly one value.
  for (const img of task.images) args.push(`--image=${img}`);
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

// Chat Completions over any OpenAI-compatible endpoint (OpenAI itself, Moonshot/Kimi, …).
async function rewriteWithChatCompletions(p, text, instruction, onChunk, task, signal) {
  if (!p.key) throw new Error(`${p.keyVar} not set`);
  const system = buildSystemPrompt(instruction, task);
  const url = `${p.url}/chat/completions`;
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
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.key}`,
      },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        ...(onChunk && { stream: true }),
        ...p.extra(),
      }),
    });
  } catch (e) {
    throw new Error(`${p.name} request to ${url} failed: ${e?.cause?.code || e?.cause?.errors?.[0]?.code || e.message}`);
  }
  if (!res.ok) throw new Error(`${p.name} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (onChunk) {
    // OpenAI-compatible SSE stream: `data: {json}` lines, ends with [DONE]
    let full = "", buf = "", done = false;
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      if (signal?.aborted) break;
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m) continue;
        if (m[1] === "[DONE]") { done = true; continue; }
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
    if (m && m[1] === "[DONE]") done = true;
    else if (m) {
      try {
        const delta = JSON.parse(m[1])?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch {}
    }
    if (!done) throw new Error(`${p.name} stream ended before [DONE]`);
    const out = full.trim();
    if (!out) throw new Error(`${p.name} returned empty result`);
    return out;
  }
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error(`${p.name} returned empty result`);
  return out;
}

const BACKENDS = ["claude", "codex", "openai", "kimi", "ollama"];
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
  const args = {
    backend: null, instruction: "", style: "", stream: false, logHistory: false,
    reply: false, prompt: false, ask: false, context: "", images: [],
    app: "", windowTitle: "", remember: null, syncContext: false,
    contextStatus: false, doctor: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stream") args.stream = true;
    else if (a === "--log-history") args.logHistory = true;
    else if (a === "--reply") args.reply = true;
    else if (a === "--prompt") args.prompt = true;
    else if (a === "--ask") args.ask = true;
    else if (a === "--window-title" || a === "--app" || a === "--remember") {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`revoice: ${a} requires a value`);
        process.exit(1);
      }
      if (a === "--window-title") args.windowTitle = value;
      else if (a === "--app") args.app = value;
      else args.remember = value;
    } else if (a === "--sync-context") args.syncContext = true;
    else if (a === "--context-status") args.contextStatus = true;
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
    } else if (a === "--update") {
      // `git pull` the checkout the installer was last run from, then re-run install.sh
      const srcFile = path.join(CONFIG_DIR, "src-path");
      const src = fs.existsSync(srcFile) ? fs.readFileSync(srcFile, "utf8").trim() : "";
      if (!src || !fs.existsSync(path.join(src, "install.sh"))) {
        console.error(`revoice: don't know where the source is (${srcFile} missing or stale) — re-run install.sh from a checkout, or:\n  curl -fsSL https://raw.githubusercontent.com/jdanjohnson/Revoice-AI-Rewriting-Tool/main/install.sh | bash`);
        process.exit(1);
      }
      if (!fs.existsSync(path.join(src, ".git"))) {
        console.error(`revoice: ${src} is not a git checkout — cd there and update it by hand, then ./install.sh`);
        process.exit(1);
      }
      console.error(`==> Updating ${src}`);
      const pull = spawnSync("git", ["-C", src, "pull", "--ff-only"], { stdio: "inherit" });
      if (pull.status !== 0) process.exit(pull.status ?? 1);
      const inst = spawnSync("bash", [path.join(src, "install.sh")], { stdio: "inherit", env: { ...process.env, HOME: os.homedir() } });
      process.exit(inst.status ?? 1);
    } else if (a === "--doctor") {
      args.doctor = true;
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
        "Usage: echo TEXT | revoice [--backend auto|claude|codex|openai|kimi|ollama|CHAIN] [--instruction TEXT] [--style founder|casual|professional|concise|NAME] [--stream] [--log-history] [--history] [--mark-last accepted|rejected] [--skills] [--doctor] [--update]\n" +
        "       echo NOTES | revoice --reply [--context TEXT] [--image FILE]... [--app NAME] [--window-title TEXT]\n" +
        "       echo TEXT | revoice --prompt | --ask\n" +
        "       revoice --remember TEXT | --sync-context | --context-status"
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

async function rewriteWithOllama(text, instruction, task) {
  const user = { role: "user", content: buildTaskMessage(text, task) };
  // Ollama vision models take raw base64 (no data: prefix)
  if (task.images.length)
    user.images = task.images.map((f) => fs.readFileSync(f).toString("base64"));
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { num_ctx: OLLAMA_NUM_CTX },
      messages: [
        { role: "system", content: buildOllamaSystemPrompt(instruction, task) },
        user,
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return cleanOllamaOutput(data?.message?.content || "", text, task);
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

function doctorLines() {
  const { chain } = resolveChain(process.env.REWRITE_BACKEND);
  const codex = findCodex();
  const claude = findClaude();
  return {
    codex,
    claude,
    lines: [
      `backend chain: ${chain.join(" → ")}  (REWRITE_BACKEND=${process.env.REWRITE_BACKEND || "<unset>"})`,
      `codex:  ${codex ? `${codex}  (model ${CODEX_MODEL})` : "NOT FOUND — npm i -g @openai/codex, or set CODEX_BIN in ~/.revoice/env"}`,
      `claude: ${claude || "NOT FOUND — npm i -g @anthropic-ai/claude-code, or set CLAUDE_BIN in ~/.revoice/env"}`,
      `openai: ${OPENAI_API_KEY ? `key set  (${OPENAI_API_URL}, model ${OPENAI_MODEL}, effort ${OPENAI_REASONING_EFFORT})` : "no OPENAI_API_KEY (optional: paid API, faster than codex)"}`,
      `kimi:   ${process.env.KIMI_API_KEY ? `key set  (${KIMI_API_URL}, model ${KIMI_MODEL})` : "no KIMI_API_KEY"}`,
      `ollama: ${OLLAMA_URL}  (model ${OLLAMA_MODEL}, prompt ${OLLAMA_PROMPT})`,
      `PATH:   ${process.env.PATH || ""}`,
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.remember !== null) {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true, mode: 0o700 });
    const line = `- ${new Date().toISOString().slice(0, 10)} ${args.remember}\n`;
    fs.appendFileSync(path.join(CONTEXT_DIR, "notes.md"), line, { encoding: "utf8", mode: 0o600 });
    console.log("remembered");
    return;
  }
  if (args.syncContext) {
    try {
      const body = await syncZoeyContext();
      console.log(`synced Zoey context (${body.length} chars)`);
      return;
    } catch (error) {
      console.error(`revoice: could not sync Zoey context: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (args.contextStatus || args.doctor) {
    if (args.doctor) {
      const doctor = doctorLines();
      for (const line of doctor.lines) console.log(line);
    }
    for (const line of await contextStatus()) console.log(line);
    if (args.doctor) {
      const doctor = doctorLines();
      process.exitCode = doctor.codex || doctor.claude || OPENAI_API_KEY || process.env.KIMI_API_KEY ? 0 : 1;
    }
    return;
  }
  ACTIVE_STYLE = args.style;
  if (args.style) loadPrompt(args.style); // validate the style up front

  const selectedModes = [args.reply, args.prompt, args.ask].filter(Boolean).length;
  if (selectedModes > 1) {
    console.error("revoice: --reply, --prompt, and --ask are mutually exclusive");
    process.exit(1);
  }
  const mode = args.reply ? "reply" : args.prompt ? "prompt" : args.ask ? "ask" : "rewrite";
  const text = (await readStdin()).trim();
  const task = {
    mode,
    context: (args.context || "").trim(),
    images: args.images,
    app: args.app,
    windowTitle: args.windowTitle,
  };
  if (mode !== "reply" && (task.context || task.images.length)) {
    console.error("revoice: --context/--image only apply with --reply");
    process.exit(1);
  }
  if (!text && mode !== "reply") {
    console.error("revoice: no input text on stdin");
    process.exit(1);
  }
  const gathered = await gatherContext({ mode, text, context: task.context, windowTitle: task.windowTitle, app: task.app });
  task.contextBlocks = gathered.blocks;
  for (const block of task.contextBlocks)
    console.error(`context:${block.source === "availability" ? "calendar" : block.source}`);
  if (!text && !task.context && !task.images.length && !task.contextBlocks.length) {
    console.error("revoice: nothing to reply to");
    process.exit(1);
  }

  const deadline = Date.now() + REWRITE_TIMEOUT_MS;
  const errors = [];
  // In --stream mode Kimi chunks are written to stdout as they arrive; emit()
  // then only needs to flush whatever wasn't already streamed. Ollama is
  // buffered so its output can be cleaned/rejected before any of it is shown.
  let streamedChars = 0;
  const flush = (s) => {
    streamedChars += s.length;
    process.stdout.write(s);
  };
  // Streamed text is forwarded line by line; a line that starts like `FLAGS:` (or could still
  // become one) is held back so the flags never reach stdout/the HUD.
  let held = "", lineStart = true, flagsSeen = false;
  const resetStream = () => { held = ""; lineStart = true; flagsSeen = false; };
  const flagsOff = draftHasFlagsLine(text);
  const onChunk = args.stream
    ? (delta) => {
        if (flagsOff) return flush(delta);
        if (flagsSeen) return;
        held += delta;
        let nl;
        while ((nl = held.indexOf("\n")) >= 0) {
          const line = held.slice(0, nl + 1);
          if (lineStart && FLAGS_LINE.test(line)) { flagsSeen = true; held = ""; return; }
          flush(line);
          held = held.slice(nl + 1);
          lineStart = true;
        }
        const couldBeFlags = lineStart && (FLAGS_LINE.test(held) || FLAGS_PREFIX.test(held));
        if (held && !couldBeFlags) {
          flush(held);
          held = "";
          lineStart = false;
        }
      }
    : null;
  const emit = (raw, via) => {
    const { rewrite: out, flags } = splitFlags(raw, text);
    if (via) console.error(`via:${via}`);
    for (const f of flags) console.error(`flag:${f}`);
    if (args.logHistory) {
      appendHistory({
        ts: new Date().toISOString(),
        original: (text || task.context).slice(0, 2000),
        rewrite: out.slice(0, 2000),
        style: args.style || "",
        instruction: args.instruction || "",
        ...(task.mode !== "rewrite" && { mode: task.mode, images: task.images.length }),
        ...(flags.length && { flags }),
        via,
      });
    }
    const rest = out.length > streamedChars ? out.slice(streamedChars) : "";
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

  // a timed-out API request is aborted so its late chunks can't bleed into the next backend's output
  const chatApi = (p) => {
    const ac = new AbortController();
    return withTimeout(rewriteWithChatCompletions(p, text, args.instruction, onChunk, task, ac.signal), remaining(10000), p.name, () => ac.abort());
  };
  const runners = {
    claude: () => rewriteWithClaude(text, args.instruction, cliBudget("CLAUDE_TIMEOUT_MS"), task),
    codex: () => rewriteWithCodex(text, args.instruction, cliBudget("CODEX_TIMEOUT_MS"), task),
    openai: () => chatApi(OPENAI_PROVIDER),
    kimi: () => chatApi(KIMI_PROVIDER),
    ollama: () => withTimeout(rewriteWithOllama(text, args.instruction, task), remaining(10000), "Ollama"),
  };

  for (const backend of chain) {
    // API backends only join an automatic chain when their key is configured.
    if (backend === "openai" && !OPENAI_API_KEY && !explicit) continue;
    if (backend === "kimi" && !KIMI_API_KEY && !explicit) continue;
    if (backend === "ollama" && errors.length)
      console.error(`revoice: ${errors.join("; ")} — falling back to local Ollama (${OLLAMA_MODEL})`);
    resetStream();
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error("revoice: " + (e?.message || e));
    process.exit(1);
  });
}

export { zoCall, gatherContext, computeFreeSlots, parseBusyIntervals, buildTaskMessage };
