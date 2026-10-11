#!/usr/bin/env node
// Tests for Reply mode (--reply / --context / --image) in bin/revoice.js.
// Run: node test/reply-mode.test.mjs  (or `npm test` for everything)
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "bin", "revoice.js");
const T = path.join(HERE, ".tmp-reply");
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const HOME = path.join(T, "home");
fs.mkdirSync(path.join(HOME, ".revoice"), { recursive: true });
const PROMPT_FILE = path.join(T, "prompt.txt");
fs.writeFileSync(PROMPT_FILE, "TEST PROMPT: never reply, only rewrite.");
fs.mkdirSync(path.join(T, "no-skills"));
fs.writeFileSync(path.join(T, "package.json"), '{"type":"module"}');
const LOG = path.join(T, "codex.log");
const CLAUDE_LOG = path.join(T, "claude.log");
const HIST = path.join(T, "history.jsonl");

// fixture images: tiny PNG + JPG with known bytes
const PNG = path.join(T, "thread.png");
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
fs.writeFileSync(PNG, PNG_BYTES);
const JPG = path.join(T, "second shot.jpg"); // space in path on purpose
const JPG_BYTES = Buffer.from("ffd8ffe000104a464946", "hex");
fs.writeFileSync(JPG, JPG_BYTES);

// fake codex: logs argv, writes the full prompt into --output-last-message.
// Mirrors codex-cli 0.154.0's clap parsing (verified against the real binary):
// `--image <FILE>...` is greedy and eats every following non-flag arg, so a
// bare `--image PATH PROMPT` leaves no positional prompt -> exit 1 with
// "No prompt provided via stdin."; `--image=PATH` binds exactly one value.
const FAKE_CODEX = path.join(T, "codex");
fs.writeFileSync(FAKE_CODEX, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv }) + "\\n");
if (process.env.FAKE_CODEX_MODE === "fail") { process.stderr.write("ERROR: boom\\n"); process.exit(1); }
const oneValue = new Set(["--model", "-m", "-c", "--sandbox", "--color", "--output-last-message"]);
let prompt = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--image" || a === "-i") { while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) i++; }
  else if (oneValue.has(a)) i++;
  else if (!a.startsWith("-")) prompt = a;
}
if (prompt === null) { process.stderr.write("Reading prompt from stdin...\\nNo prompt provided via stdin.\\n"); process.exit(1); }
const oi = argv.indexOf("--output-last-message");
fs.writeFileSync(argv[oi + 1], "CODEX-OUT\\n");
`, { mode: 0o755 });
const FAKE_CLAUDE = path.join(T, "claude");
fs.writeFileSync(FAKE_CLAUDE, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv }) + "\\n");
if (process.env.FAKE_CLAUDE_MODE === "fail") { process.stderr.write("not logged in\\n"); process.exit(1); }
process.stdout.write("CLAUDE-OUT");
`, { mode: 0o755 });

const servers = spawn("node", [path.join(HERE, "fake-servers.mjs"), T], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => servers.stdout.once("data", r));
process.on("exit", () => servers.kill());
process.on("uncaughtException", (e) => { console.log("CRASH " + e.stack); servers.kill(); process.exit(2); });

const baseEnv = {
  PATH: "/usr/bin:/bin:/usr/local/bin",
  HOME,
  REWRITE_PROMPT_FILE: PROMPT_FILE,
  REWRITE_SKILLS_DIR: path.join(T, "no-skills"),
  VOICE_SAMPLES_FILE: path.join(T, "none.txt"),
  REWRITE_HISTORY_FILE: HIST,
  REWRITE_STYLES_DIR: path.join(T, "no-styles"),
  CODEX_BIN: FAKE_CODEX,
  CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CODEX_LOG: LOG,
  FAKE_CLAUDE_LOG: CLAUDE_LOG,
  OLLAMA_URL: "http://127.0.0.1:4711",
  KIMI_API_URL: "http://127.0.0.1:4713",
  KIMI_API_KEY: "test-key",
};
const logs = [LOG, CLAUDE_LOG, path.join(T, "ollama.log"), path.join(T, "kimi-ok.log"), HIST];
function run(input, args, env = {}) {
  for (const f of logs) fs.rmSync(f, { force: true });
  const r = spawnSync("node", [CLI, ...args], { input, env: { ...baseEnv, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const codexArgv = () => lines(LOG).map((l) => JSON.parse(l).argv);
const claudeArgv = () => lines(CLAUDE_LOG).map((l) => JSON.parse(l).argv);
const ollamaBodies = () => lines(path.join(T, "ollama.log")).map(JSON.parse);
const kimiBodies = () => lines(path.join(T, "kimi-ok.log")).map(JSON.parse);
const calls = () => [codexArgv().length, claudeArgv().length, kimiBodies().length, ollamaBodies().length];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      ${detail ?? ""}`); }
}
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);

const SYS = "TEST PROMPT: never reply, only rewrite.";
const NOTES = "yes but not before friday — need Sam's sign-off on the SOW first";
const CTX = "Dylan: can we ship the Q3 deck tomorrow?\nDylan: also is the SOW done";
const HEAD =
  "REPLY MODE (this overrides any rule above about never replying): draft the author's reply to a conversation. " +
  "Do not rewrite the notes below; use them (and the conversation) to write what the author would send next. " +
  "Keep the author's voice rules, and never invent facts, dates, or commitments the notes don't give.";
const IMG_LINE = "\nThe attached screenshot shows the conversation the author is replying to. Read it carefully — the author is the person about to send the next message.";
const TAIL =
  "\n\nOutput only the reply, ready to send, in the author's voice, matching the channel's format " +
  "(chat → short; email → a little more structure). No preamble, no quotes, no explanation.";
const brief = ({ notes, ctx, img }) =>
  HEAD + (img ? IMG_LINE : "") +
  (ctx ? "\n\nCONVERSATION CONTEXT (what the author is replying to):\n" + ctx : "") +
  (notes ? "\n\nWHAT THE AUTHOR WANTS TO SAY (rough notes):\n" + notes
         : "\n\nWHAT THE AUTHOR WANTS TO SAY: no notes given — infer the natural, useful reply from the conversation.") +
  TAIL;
const CODEX_FIXED = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "--output-last-message"];
// drop the random -o path (index 8) so argv can be compared exactly
const stripOut = (a) => a.slice(0, 8).concat(a.slice(9));

// ---- 1. codex reply: image + notes + context ----------------------------------
{
  const r = run(NOTES, ["--backend", "codex", "--reply", "--image", PNG, "--context", CTX]);
  eq("codex reply: exit 0 + output + via", [r.code, r.out, r.err.trim()], [0, "CODEX-OUT", "via:codex"]);
  eq("codex reply: exactly one codex call, nothing else", calls(), [1, 0, 0, 0]);
  eq("codex reply: argv = fixed flags, model/effort, --image=<abs path>, prompt last",
    stripOut(codexArgv()[0]),
    [...CODEX_FIXED, "--model", "gpt-6-astra", "-c", 'model_reasoning_effort="low"', `--image=${PNG}`,
     SYS + "\n\n" + brief({ notes: NOTES, ctx: CTX, img: true })]);
}
// ---- 2. two images (one with a space in its path, relative) ----------------------
{
  for (const f of logs) fs.rmSync(f, { force: true });
  const r = spawnSync("node", [CLI, "--backend", "codex", "--reply", "--image", PNG, "--image", "second shot.jpg"],
    { input: NOTES, env: baseEnv, encoding: "utf8", cwd: T });
  eq("codex 2 images: exit 0", r.status, 0);
  const a = stripOut(codexArgv()[0]);
  eq("codex 2 images: both --image=FILE args, in order, relative path resolved",
    a.slice(12, 14), [`--image=${PNG}`, `--image=${JPG}`]);
  eq("codex 2 images: prompt (no context) is still last", a[14], SYS + "\n\n" + brief({ notes: NOTES, img: true }));
}
// ---- 3. empty notes, image only -> infer -----------------------------------------
{
  const r = run("", ["--backend", "codex", "--reply", "--image", PNG]);
  eq("empty notes + image: exit 0", [r.code, r.out], [0, "CODEX-OUT"]);
  eq("empty notes + image: brief says infer", stripOut(codexArgv()[0]).slice(-1)[0], SYS + "\n\n" + brief({ img: true }));
}
// ---- 4. empty notes, context only (no image) -----------------------------------
{
  const r = run("   \n", ["--backend", "codex", "--reply", "--context", CTX]);
  eq("whitespace notes + context: exit 0", r.code, 0);
  eq("whitespace notes + context: brief has context, no image line, infer",
    stripOut(codexArgv()[0]).slice(-1)[0], SYS + "\n\n" + brief({ ctx: CTX }));
  eq("context only: no --image in argv", codexArgv()[0].includes("--image"), false);
}
// ---- 5. error paths ------------------------------------------------------------------
{
  let r = run("", ["--backend", "codex", "--reply"]);
  eq("reply with nothing: exit 1 + message", [r.code, r.err.trim(), r.out], [1, "revoice: reply mode needs notes on stdin, --context, or --image", ""]);
  eq("reply with nothing: no backend contacted", calls(), [0, 0, 0, 0]);
  r = run(NOTES, ["--backend", "codex", "--reply", "--image", path.join(T, "nope.png")]);
  eq("missing image file: exit 1 + message", [r.code, r.err.trim()], [1, `revoice: --image file not found: ${path.join(T, "nope.png")}`]);
  eq("missing image file: no backend contacted", calls(), [0, 0, 0, 0]);
  r = run(NOTES, ["--backend", "codex", "--reply", "--image"]);
  eq("--image without value: exit 1", [r.code, r.err.trim()], [1, "revoice: --image requires a file path"]);
  r = run(NOTES, ["--backend", "codex", "--reply", "--context"]);
  eq("--context without value: exit 1", [r.code, r.err.trim()], [1, "revoice: --context requires a value (the message you're replying to)"]);
  r = run(NOTES, ["--backend", "codex", "--image", PNG]);
  eq("--image without --reply: exit 1", [r.code, r.err.trim()], [1, "revoice: --context/--image only apply with --reply"]);
  r = run(NOTES, ["--backend", "codex", "--context", CTX]);
  eq("--context without --reply: exit 1", [r.code, r.err.trim()], [1, "revoice: --context/--image only apply with --reply"]);
  eq("--context without --reply: no backend contacted", calls(), [0, 0, 0, 0]);
  r = run("", ["--backend", "codex"]);
  eq("plain rewrite, empty stdin still rejected", [r.code, r.err.trim()], [1, "revoice: no input text on stdin"]);
}
// ---- 6. plain rewrite regression: no --image, DRAFT block ------------------------------
{
  const r = run(NOTES, ["--backend", "codex"]);
  eq("plain rewrite: exit 0", r.code, 0);
  eq("plain rewrite: argv unchanged (no --image, draft block)",
    stripOut(codexArgv()[0]),
    [...CODEX_FIXED, "--model", "gpt-6-astra", "-c", 'model_reasoning_effort="low"',
     SYS + "\n\nDRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + NOTES]);
}
// ---- 7. claude reply ------------------------------------------------------------------
{
  let r = run(NOTES, ["--backend", "claude", "--reply", "--image", PNG, "--context", CTX]);
  eq("claude reply: exit 0 + via", [r.code, r.out, r.err.trim()], [0, "CLAUDE-OUT", "via:claude"]);
  eq("claude reply: -p prompt + path list + --allowedTools Read",
    claudeArgv()[0],
    ["-p", SYS + "\n\n" + brief({ notes: NOTES, ctx: CTX, img: true }) +
      "\n\nScreenshot file(s) of the conversation — read each with your Read tool before drafting:\n" + PNG,
     "--allowedTools", "Read"]);
  r = run(NOTES, ["--backend", "claude", "--reply", "--context", CTX]);
  eq("claude reply w/o image: no --allowedTools, no path list",
    claudeArgv()[0], ["-p", SYS + "\n\n" + brief({ notes: NOTES, ctx: CTX })]);
  r = run(NOTES, ["--backend", "claude"]);
  eq("claude plain rewrite: unchanged argv",
    claudeArgv()[0], ["-p", SYS + "\n\nDRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + NOTES]);
}
// ---- 8. kimi reply (OpenAI vision parts) ------------------------------------------------
{
  let r = run(NOTES, ["--backend", "kimi", "--reply", "--image", PNG, "--image", JPG, "--context", CTX]);
  eq("kimi reply: exit 0 + via", [r.code, r.err.trim()], [0, "via:kimi"]);
  const b = kimiBodies()[0];
  eq("kimi reply: system prompt untouched", b.messages[0], { role: "system", content: SYS });
  eq("kimi reply: user content = text part + image_url data URLs (png, jpeg mime, exact base64)",
    b.messages[1],
    { role: "user", content: [
      { type: "text", text: brief({ notes: NOTES, ctx: CTX, img: true }) },
      { type: "image_url", image_url: { url: "data:image/png;base64," + PNG_BYTES.toString("base64") } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + JPG_BYTES.toString("base64") } },
    ] });
  eq("kimi reply: output is model text", r.out, "KIMI: " + brief({ notes: NOTES, ctx: CTX, img: true }).slice(0, 40));
  r = run(NOTES, ["--backend", "kimi", "--reply", "--context", CTX, "--stream"]);
  eq("kimi reply no image (stream): user content is the plain brief string",
    kimiBodies()[0].messages[1], { role: "user", content: brief({ notes: NOTES, ctx: CTX }) });
  eq("kimi reply stream: streamed output", [r.code, r.out], [0, "KIMI: " + brief({ notes: NOTES, ctx: CTX }).slice(0, 40)]);
  r = run(NOTES, ["--backend", "kimi"]);
  eq("kimi plain rewrite: user content is just the draft (regression)",
    kimiBodies()[0].messages[1], { role: "user", content: NOTES });
}
// ---- 9. ollama reply (images: raw base64) -----------------------------------------------
{
  let r = run(NOTES, ["--backend", "ollama", "--reply", "--image", PNG]);
  eq("ollama reply: exit 0 + via", [r.code, r.err.trim()], [0, "via:ollama"]);
  eq("ollama reply: user message = brief + images[base64]",
    ollamaBodies()[0].messages[1],
    { role: "user", content: brief({ notes: NOTES, img: true }), images: [PNG_BYTES.toString("base64")] });
  eq("ollama reply: compact reply system prompt (no never-reply rule)",
    [ollamaBodies()[0].messages[0].role, ollamaBodies()[0].messages[0].content.startsWith("You are drafting a message on behalf of the author")], ["system", true]);
  r = run(NOTES, ["--backend", "ollama"]);
  eq("ollama plain rewrite: no images key, content = framed draft",
    ollamaBodies()[0].messages[1], { role: "user", content: "DRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + NOTES });
}
// ---- 10. history logging in reply mode --------------------------------------------------
{
  run(NOTES, ["--backend", "codex", "--reply", "--image", PNG, "--context", CTX, "--log-history"]);
  let h = lines(HIST).map(JSON.parse);
  eq("history reply: one entry", h.length, 1);
  const { ts, ...rest } = h[0];
  eq("history reply: fields (original = notes, mode reply, image count)",
    rest, { original: NOTES, rewrite: "CODEX-OUT", style: "", instruction: "", mode: "reply", images: 1, via: "codex" });
  run("", ["--backend", "codex", "--reply", "--context", CTX, "--log-history"]);
  h = lines(HIST).map(JSON.parse);
  eq("history reply, empty notes: original falls back to context, images 0",
    [h[0].original, h[0].images], [CTX, 0]);
  run(NOTES, ["--backend", "codex", "--log-history"]);
  h = lines(HIST).map(JSON.parse);
  eq("history plain rewrite: no mode/images keys", ["mode" in h[0], "images" in h[0], h[0].original], [false, false, NOTES]);
}
// ---- 11. chain: claude fails -> codex still gets the image; explicit codex fail = no fallthrough
{
  let r = run(NOTES, ["--reply", "--image", PNG], { FAKE_CLAUDE_MODE: "fail", REWRITE_BACKEND: "claude,codex" });
  eq("auto chain reply: claude failed, codex answered", [r.code, r.out, r.err.trim()], [0, "CODEX-OUT", "via:codex"]);
  eq("auto chain reply: codex call still carries --image", codexArgv()[0].slice(13, 14), [`--image=${PNG}`]);
  eq("auto chain reply: claude was tried first with the image", claudeArgv()[0].slice(2), ["--allowedTools", "Read"]);
  r = run(NOTES, ["--backend", "codex", "--reply", "--image", PNG], { FAKE_CODEX_MODE: "fail" });
  eq("explicit codex reply failure: exit 1, nothing else contacted", [r.code, r.out, calls()], [1, "", [1, 0, 0, 0]]);
  eq("explicit codex reply failure: error surfaced", r.err.includes("codex exited 1: ERROR: boom"), true, r.err);
}
// ---- 12. help mentions reply mode ---------------------------------------------------------------
{
  const r = run("", ["--help"]);
  eq("help: reply usage line", r.out.includes("revoice --reply [--context TEXT] [--image FILE]..."), true, r.out);
}

console.log(`\n${pass} passed, ${fail} failed`);
servers.kill();
process.exit(fail ? 1 : 0);
