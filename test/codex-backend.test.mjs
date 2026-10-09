#!/usr/bin/env node
// Tests for the Codex (GPT-6 Astra) backend + REWRITE_BACKEND chain in bin/revoice.js.
// Run: node test/codex-backend.test.mjs  (or `npm test` for everything)
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "bin", "revoice.js");
const T = path.join(HERE, ".tmp-codex");
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const HOME = path.join(T, "home");
fs.mkdirSync(path.join(HOME, ".revoice"), { recursive: true });
const PROMPT_FILE = path.join(T, "prompt.txt");
fs.writeFileSync(PROMPT_FILE, "TEST PROMPT: rewrite plainly.");
const SKILLS_DIR = path.join(T, "no-skills");
fs.mkdirSync(SKILLS_DIR);
const LOG = path.join(T, "codex.log"); // JSON lines: {argv, stdinBytes, cwd}
const CLAUDE_LOG = path.join(T, "claude.log");
const OLLAMA_LOG = path.join(T, "ollama.log");

// ---- fake codex: logs argv/stdin/cwd, behaves per FAKE_CODEX_MODE ----
const FAKE_CODEX = path.join(T, "codex");
fs.writeFileSync(
  FAKE_CODEX,
  `#!/usr/bin/env node
import fs from "node:fs";
let stdinBytes = 0;
try { stdinBytes = fs.readFileSync(0).length; } catch {}
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, stdinBytes, cwd: process.cwd() }) + "\\n");
const mode = process.env.FAKE_CODEX_MODE || "ok";
const oi = argv.indexOf("--output-last-message");
const outFile = oi >= 0 ? argv[oi + 1] : null;
const prompt = argv[argv.length - 1];
const draft = prompt.split("output only the rewritten draft):\\n")[1];
if (mode === "ok") {
  process.stdout.write("OpenAI Codex v0.153.4\\n--------\\nworkdir: /tmp\\nmodel: gpt-6-astra\\n"); // progress noise
  fs.writeFileSync(outFile, "CODEX: " + draft + "\\n");
  process.exit(0);
} else if (mode === "stdout-only") {
  process.stdout.write("  CODEX-STDOUT: " + draft + "  \\n");
  process.exit(0);
} else if (mode === "fail") {
  process.stderr.write("2026-09-08T17:13:31Z  INFO codex_rollout::metadata: state db backfill\\n");
  process.stderr.write("2026-09-08T17:13:51Z  WARN codex_core::responses_retry: stream disconnected\\n");
  process.stderr.write("ERROR: Reconnecting... 5/5\\n");
  process.stderr.write("ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header\\n");
  process.stderr.write("tokens used\\n0\\n");
  process.exit(1);
} else if (mode === "empty") {
  fs.writeFileSync(outFile, "   \\n");
  process.exit(0);
} else if (mode === "hang") {
  fs.writeFileSync(outFile, "PARTIAL");
  setTimeout(() => {}, 60000);
}
`,
  { mode: 0o755 }
);
const FAKE_CLAUDE = path.join(T, "claude");
fs.writeFileSync(
  FAKE_CLAUDE,
  `#!/usr/bin/env node
import fs from "node:fs";
let stdinBytes = 0; try { stdinBytes = fs.readFileSync(0).length; } catch {}
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, stdinBytes }) + "\\n");
if (process.env.FAKE_CLAUDE_MODE === "fail") { process.stderr.write("not logged in\\n"); process.exit(1); }
process.stdout.write("CLAUDE: " + argv[1].split("output only the rewritten draft):\\n")[1]);
`,
  { mode: 0o755 }
);
// node ESM shebang scripts need .mjs — wrap via package.json type=module in T
fs.writeFileSync(path.join(T, "package.json"), '{"type":"module"}');

// ---- fake ollama (4711) + fake dying-stream kimi (4712) in a separate process ----
const servers = spawn("node", [path.join(HERE, "fake-servers.mjs"), T], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => servers.stdout.once("data", r));
process.on("exit", () => servers.kill());
process.on("uncaughtException", (e) => { console.log("CRASH " + e.stack); servers.kill(); process.exit(2); });

const baseEnv = {
  PATH: "/usr/bin:/bin:/usr/local/bin",
  HOME,
  REWRITE_PROMPT_FILE: PROMPT_FILE,
  REWRITE_SKILLS_DIR: SKILLS_DIR,
  VOICE_SAMPLES_FILE: path.join(T, "none.txt"),
  REWRITE_HISTORY_FILE: path.join(T, "none.jsonl"),
  REWRITE_STYLES_DIR: path.join(T, "no-styles"),
  CODEX_BIN: FAKE_CODEX,
  CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CODEX_LOG: LOG,
  FAKE_CLAUDE_LOG: CLAUDE_LOG,
  OLLAMA_URL: "http://127.0.0.1:4711",
  KIMI_API_URL: "http://127.0.0.1:4712",
};

function run(input, args, env = {}) {
  for (const f of [LOG, CLAUDE_LOG, OLLAMA_LOG, path.join(T, "kimi.log")]) fs.rmSync(f, { force: true });
  const r = spawnSync("node", [CLI, ...args], { input, env: { ...baseEnv, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const codexCalls = () => lines(LOG).map((l) => JSON.parse(l));
const codexArgv = (i = 0) => (codexCalls()[i] || { argv: [] }).argv;
const claudeCalls = () => lines(CLAUDE_LOG).length;
const ollamaCalls = () => lines(OLLAMA_LOG).length;
const kimiCalls = () => lines(path.join(T, "kimi.log")).length;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      ${detail ?? ""}`); }
}
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);

const DRAFT = "hey — can u send the Q3 SOW + MSA over today? it's a big \"deal\" for us\nthx";
// Ollama gets the framed draft as its user message (see ollama.test.mjs); the fake echoes it back
const OLLAMA_OUT = "OLLAMA: DRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + DRAFT;
const lastErr = (r) => r.err.trim().split("\n").pop();
const fellBack = (r) => /^revoice: .* — falling back to local Ollama \(llama3\.2:3b\)$/.test(r.err.trim().split("\n")[0]);

// 1. explicit codex: argv contract, prompt composition, output from -o file, stdin closed, cwd tmp
{
  const r = run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "ok" });
  eq("codex: exit 0", r.code, 0);
  eq("codex: stdout is file content trimmed (progress noise dropped)", r.out, "CODEX: " + DRAFT);
  eq("codex: via label", r.err.trim(), "via:codex");
  const calls = codexCalls();
  eq("codex: invoked exactly once", calls.length, 1);
  const a = calls[0].argv;
  const expectedPrompt =
    "TEST PROMPT: rewrite plainly." +
    "\n\nDRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + DRAFT;
  eq("codex: argv (fixed flags, default model + low effort, prompt last)",
    a.slice(0, 8).concat(a.slice(9)),
    ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "--output-last-message",
     "--model", "gpt-6-astra", "-c", 'model_reasoning_effort="low"', expectedPrompt]);
  check("codex: -o path is in tmpdir and cleaned up", a[8].startsWith(path.join(os.tmpdir(), "revoice-codex-")) && !fs.existsSync(a[8]), a[8]);
  eq("codex: stdin closed (0 bytes read by codex)", calls[0].stdinBytes, 0);
  eq("codex: cwd is tmpdir (not user's git repo)", calls[0].cwd, os.tmpdir());
  eq("codex: no other backend contacted", [claudeCalls(), ollamaCalls(), kimiCalls()], [0, 0, 0]);
}

// 2. prompt parity with claude (same composition incl. instruction)
{
  const r1 = run(DRAFT, ["--backend", "codex", "-i", "shorter"], { FAKE_CODEX_MODE: "ok" });
  const codexPrompt = codexArgv().at(-1);
  const r2 = run(DRAFT, ["--backend", "claude", "-i", "shorter"]);
  const claudePrompt = JSON.parse(lines(CLAUDE_LOG)[0]).argv[1];
  eq("codex/claude: identical prompt text for same input+instruction", codexPrompt, claudePrompt);
  check("codex/claude: instruction present", codexPrompt.includes("\n\nAdditional instruction: shorter\n\nDRAFT TO REWRITE"), codexPrompt);
  eq("codex/claude: both exit 0", [r1.code, r2.code], [0, 0]);
}

// 3. env overrides: model + effort; empty values omit flags
{
  run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "ok", CODEX_MODEL: "gpt-5.1", CODEX_REASONING_EFFORT: "high" });
  let a = codexArgv();
  eq("codex: CODEX_MODEL/CODEX_REASONING_EFFORT honored", [a[a.indexOf("--model") + 1], a[a.indexOf("-c") + 1]], ["gpt-5.1", 'model_reasoning_effort="high"']);
  run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "ok", CODEX_MODEL: "", CODEX_REASONING_EFFORT: "" });
  a = codexArgv();
  eq("codex: empty CODEX_MODEL falls back to default gpt-6-astra", a[a.indexOf("--model") + 1], "gpt-6-astra");
  eq("codex: empty effort falls back to low", a[a.indexOf("-c") + 1], 'model_reasoning_effort="low"');
  run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "ok", CODEX_REASONING_EFFORT: "  medium  " });
  a = codexArgv();
  eq("codex: effort is trimmed", a[a.indexOf("-c") + 1], 'model_reasoning_effort="medium"');
}

// 4. ~/.revoice/env supplies CODEX_* and REWRITE_BACKEND
{
  fs.writeFileSync(path.join(HOME, ".revoice", "env"), 'REWRITE_BACKEND=codex\nCODEX_MODEL="gpt-6-astra-mini" # comment\n');
  const r = run(DRAFT, [], { FAKE_CODEX_MODE: "ok" });
  const a = codexArgv();
  eq("env file: REWRITE_BACKEND=codex routes to codex with no --backend flag", [r.code, r.err.trim()], [0, "via:codex"]);
  eq("env file: quoted CODEX_MODEL with trailing comment parsed", a[a.indexOf("--model") + 1], "gpt-6-astra-mini");
  eq("env file: claude NOT contacted (explicit codex)", claudeCalls(), 0);
  fs.rmSync(path.join(HOME, ".revoice", "env"));
}

// 5. stdout fallback when -o file missing
{
  const r = run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "stdout-only" });
  eq("codex: falls back to trimmed stdout when no output file", [r.code, r.out], [0, "CODEX-STDOUT: " + DRAFT]);
}

// 6. failure: explicit codex → exit 1, concise error (last ERROR line), nothing else contacted
{
  const r = run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "fail" });
  eq("codex fail: exit 1 + empty stdout", [r.code, r.out], [1, ""]);
  eq("codex fail: stderr = last ERROR line only (no INFO/WARN noise)", r.err.trim(),
    "codex: codex exited 1: ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header");
  eq("codex fail: isolation (no claude/ollama/kimi)", [claudeCalls(), ollamaCalls(), kimiCalls()], [0, 0, 0]);
}

// 7. empty output = failure
{
  const r = run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "empty" });
  eq("codex empty: exit 1 with 'empty output'", [r.code, r.err.trim()], [1, "codex: codex exited 0: empty output"]);
}

// 8. codex missing binary → in auto chain skipped instantly, falls to ollama
{
  const r = run(DRAFT, [], { CODEX_BIN: path.join(T, "nope"), CLAUDE_BIN: path.join(T, "nope2") });
  eq("auto: missing claude+codex → ollama (with fallback warning)", [r.code, r.out, lastErr(r), fellBack(r)], [0, OLLAMA_OUT, "via:ollama", true]);
  eq("auto: kimi skipped (no key) in auto chain", kimiCalls(), 0);
}

// 9. default auto order: claude first, then codex (claude fails → codex answers)
{
  const r = run(DRAFT, [], { FAKE_CLAUDE_MODE: "fail", FAKE_CODEX_MODE: "ok" });
  eq("auto: claude fails → codex handles it", [r.code, r.out, r.err.trim()], [0, "CODEX: " + DRAFT, "via:codex"]);
  eq("auto: claude tried once, codex once, ollama never", [claudeCalls(), codexCalls().length, ollamaCalls()], [1, 1, 0]);
}
{
  const r = run(DRAFT, [], { FAKE_CODEX_MODE: "ok" });
  eq("auto: claude succeeds → codex never contacted", [r.out, codexCalls().length], ["CLAUDE: " + DRAFT, 0]);
}

// 10. REWRITE_BACKEND chain: codex first, then claude
{
  const r = run(DRAFT, [], { REWRITE_BACKEND: "codex,claude,kimi,ollama", FAKE_CODEX_MODE: "ok" });
  eq("chain codex,...: codex answers, claude untouched", [r.err.trim(), claudeCalls()], ["via:codex", 0]);
  const r2 = run(DRAFT, [], { REWRITE_BACKEND: "codex,claude,kimi,ollama", FAKE_CODEX_MODE: "fail" });
  eq("chain codex,...: codex fails → claude", [r2.code, r2.out, r2.err.trim()], [0, "CLAUDE: " + DRAFT, "via:claude"]);
  const r3 = run(DRAFT, [], { REWRITE_BACKEND: "codex,ollama", FAKE_CODEX_MODE: "fail" });
  eq("chain codex,ollama: codex fails → ollama, claude skipped", [lastErr(r3), fellBack(r3), claudeCalls(), ollamaCalls()], ["via:ollama", true, 0, 1]);
}

// 11. --backend overrides REWRITE_BACKEND
{
  const r = run(DRAFT, ["--backend", "ollama"], { REWRITE_BACKEND: "codex", FAKE_CODEX_MODE: "ok" });
  eq("--backend beats REWRITE_BACKEND", [r.err.trim(), codexCalls().length], ["via:ollama", 0]);
}

// 12. chain exhaustion message
{
  const r = run(DRAFT, [], { REWRITE_BACKEND: "codex,claude", FAKE_CODEX_MODE: "fail", FAKE_CLAUDE_MODE: "fail" });
  eq("chain exhausted: exit 1, both errors listed, ollama NOT contacted", [r.code, ollamaCalls()], [1, 0]);
  check("chain exhausted: message lists codex then claude", /^revoice failed — codex: codex exited 1: ERROR: unexpected status 401.*; claude: claude exited 1: not logged in$/.test(r.err.trim()), r.err.trim());
}

// 13. invalid values
{
  const r1 = run(DRAFT, ["--backend", "codex,foo"]);
  eq("--backend invalid member", [r1.code, r1.err.trim()], [1, 'revoice: invalid --backend "codex,foo" (use auto|claude|codex|kimi|ollama or a comma-separated chain)']);
  const r2 = run(DRAFT, ["--backend"]);
  eq("--backend missing value", [r2.code, r2.err.trim()], [1, "revoice: --backend requires a value (use auto|claude|codex|kimi|ollama or a comma-separated chain)"]);
  const r3 = run(DRAFT, [], { REWRITE_BACKEND: "astra" });
  eq("REWRITE_BACKEND invalid", [r3.code, r3.err.trim(), codexCalls().length], [1, 'revoice: invalid REWRITE_BACKEND "astra" (use auto|claude|codex|kimi|ollama or a comma-separated chain)', 0]);
  const r4 = run(DRAFT, ["--backend", "kimi"]);
  eq("explicit kimi without key fails hard (no ollama)", [r4.code, r4.err.trim(), ollamaCalls()], [1, "kimi: KIMI_API_KEY not set", 0]);
  const r5 = run(DRAFT, [], { REWRITE_BACKEND: " codex , auto ", FAKE_CODEX_MODE: "fail", FAKE_CLAUDE_MODE: "fail" });
  eq("chain 'codex,auto' dedups: codex, claude, (kimi skipped), ollama", [lastErr(r5), codexCalls().length, claudeCalls(), ollamaCalls()], ["via:ollama", 1, 1, 1]);
  const r6 = run(DRAFT, [], { REWRITE_BACKEND: "" });
  eq("REWRITE_BACKEND empty string = auto", [r6.err.trim()], ["via:claude"]);
}

// 14. streamed partial output then failure must not fall back (would corrupt stdout)
{
  const r = run(DRAFT, ["--stream"], { REWRITE_BACKEND: "kimi,codex", KIMI_API_KEY: "k", FAKE_CODEX_MODE: "ok" });
  eq("streamed partial then failure: exit 1, codex NOT invoked", [r.code, r.out, codexCalls().length], [1, "PARTIAL-", 0]);
}

// 15. timeout: CODEX_TIMEOUT_MS respected, temp file cleaned, chain continues
{
  const t0 = Date.now();
  const r = run(DRAFT, [], { REWRITE_BACKEND: "codex,ollama", FAKE_CODEX_MODE: "hang", CODEX_TIMEOUT_MS: "1500" });
  const dt = Date.now() - t0;
  eq("timeout: falls to ollama", [r.code, lastErr(r), fellBack(r)], [0, "via:ollama", true]);
  check("timeout: took ~1.5s (not 25s)", dt > 1400 && dt < 6000, `${dt}ms`);
  const outFile = codexArgv()[8];
  check("timeout: temp output file removed", !fs.existsSync(outFile), outFile);
  const r2 = run(DRAFT, ["--backend", "codex"], { FAKE_CODEX_MODE: "hang", CODEX_TIMEOUT_MS: "1200" });
  eq("timeout explicit: error message", [r2.code, r2.err.trim()], [1, "codex: codex timed out after 1200ms"]);
}

// 16. help lists codex
{
  const r = run("", ["--help"]);
  check("--help mentions codex", r.out.includes("--backend auto|claude|codex|kimi|ollama|CHAIN"), r.out);
}

servers.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
