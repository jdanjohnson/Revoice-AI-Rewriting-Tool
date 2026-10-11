#!/usr/bin/env node
// Native OpenAI API backend contract (bin/revoice.js), against the fake OpenAI in fake-servers.mjs.
// Contract: `openai` POSTs ${OPENAI_API_URL}/chat/completions with `Authorization: Bearer
// $OPENAI_API_KEY`, body {model: OPENAI_MODEL (gpt-6-astra), messages: [system = full voice
// prompt, user = draft / reply brief (+ image_url parts)], reasoning_effort: OPENAI_REASONING_EFFORT
// (low), stream only under --stream, never temperature}; prints choices[0].message.content (or the
// concatenated SSE deltas) and `via:openai`. Missing key / HTTP error / unreachable host / empty
// content are exact errors (exit 1, empty stdout). In an auto chain openai is skipped without a
// key and tried before kimi/ollama with one. Kimi keeps its own key/model/temperature and names.
// Run: `npm test openai`
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "revoice.js");
const T = path.join(HERE, ".tmp-openai");
fs.rmSync(T, { recursive: true, force: true });
const HOME = path.join(T, "home");
const RV = path.join(HOME, ".revoice");
fs.mkdirSync(path.join(RV, "skills"), { recursive: true });
fs.writeFileSync(path.join(RV, "prompt.txt"), "FULL VOICE GUIDE: write like the author.");
fs.writeFileSync(path.join(RV, "skills", "no-slop.md"), "# no-slop\nNever say delve.");
const PNG = path.join(T, "shot.png");
fs.writeFileSync(PNG, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
const LOG = path.join(T, "openai.log");
const KIMI_LOG = path.join(T, "kimi-ok.log");
const OLLAMA_LOG = path.join(T, "ollama.log");

const srv = spawn(process.execPath, [path.join(HERE, "fake-servers.mjs"), T], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res) => srv.stdout.on("data", (d) => /ready/.test(String(d)) && res()));

const DRAFT = "hey can u send the Q3 SOW over today? thx";
const FRAMED = "DRAFT TO REWRITE (re-voice this exact draft; output only the rewritten draft):\n" + DRAFT;
const base = { HOME, PATH: process.env.PATH, OPENAI_API_URL: "http://127.0.0.1:4714/v1", OPENAI_API_KEY: "sk-test-123", CODEX_BIN: path.join(T, "nope"), CLAUDE_BIN: path.join(T, "nope2"), OLLAMA_URL: "http://127.0.0.1:4711" };
function run(input, args, env = {}, opts = {}) {
  for (const f of [LOG, KIMI_LOG, OLLAMA_LOG]) fs.rmSync(f, { force: true });
  if (opts.reply === undefined) fs.rmSync(path.join(T, "openai.reply"), { force: true }); else fs.writeFileSync(path.join(T, "openai.reply"), opts.reply);
  if (opts.status === undefined) fs.rmSync(path.join(T, "openai.status"), { force: true }); else fs.writeFileSync(path.join(T, "openai.status"), String(opts.status));
  if (opts.delay === undefined) fs.rmSync(path.join(T, "openai.delay"), { force: true }); else fs.writeFileSync(path.join(T, "openai.delay"), String(opts.delay));
  if (opts.truncate) fs.writeFileSync(path.join(T, "openai.truncate"), "1"); else fs.rmSync(path.join(T, "openai.truncate"), { force: true });
  fs.rmSync(path.join(T, "openai-aborted.log"), { force: true });
  if (opts.ollamaDelay === undefined) fs.rmSync(path.join(T, "ollama.delay"), { force: true }); else fs.writeFileSync(path.join(T, "ollama.delay"), String(opts.ollamaDelay));
  const e = { ...base, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { input, env: e, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr.trim() };
}
const calls = (f = LOG) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const last = () => calls().at(-1);
const body = () => last().body;

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);
};

try {
  // ---- happy path: exact request + output ----
  let r = run(DRAFT, ["--backend", "openai"]);
  eq("openai: exit 0, stdout = model content, via:openai", [r.code, r.out, r.err], [0, "OPENAI: " + DRAFT.slice(0, 40), "via:openai"]);
  eq("openai: one POST to /v1/chat/completions with Bearer key", [calls().length, last().path, last().auth], [1, "/v1/chat/completions", "Bearer sk-test-123"]);
  eq("openai: body = gpt-6-astra, reasoning_effort low, no stream, no temperature", [body().model, body().reasoning_effort, "stream" in body(), "temperature" in body(), Object.keys(body()).sort()], ["gpt-6-astra", "low", false, false, ["messages", "model", "reasoning_effort"]]);
  eq("openai: system = full voice prompt (guide + skills), user = plain draft", [body().messages.map((m) => m.role), body().messages[0].content.startsWith("FULL VOICE GUIDE: write like the author."), body().messages[0].content.includes("Never say delve."), body().messages[1].content], [["system", "user"], true, true, DRAFT]);

  // ---- config knobs ----
  r = run(DRAFT, ["--backend", "openai"], { OPENAI_MODEL: "gpt-6-mini", OPENAI_REASONING_EFFORT: "HIGH" });
  eq("OPENAI_MODEL + OPENAI_REASONING_EFFORT (case-insensitive) honoured", [r.code, body().model, body().reasoning_effort, r.err], [0, "gpt-6-mini", "high", "via:openai"]);
  r = run(DRAFT, ["--backend", "openai"], { OPENAI_REASONING_EFFORT: "turbo" });
  eq("invalid OPENAI_REASONING_EFFORT: warned, falls back to low, request still sent", [r.code, body().reasoning_effort, r.err], [0, "low", 'revoice: ignoring invalid OPENAI_REASONING_EFFORT "turbo" (use off|none|minimal|low|medium|high|xhigh|max)\nvia:openai']);
  r = run(DRAFT, ["--backend", "openai"], { OPENAI_API_URL: "http://127.0.0.1:4714/v1/" });
  eq("trailing slash in OPENAI_API_URL: no double slash", [r.code, last().path], [0, "/v1/chat/completions"]);
  fs.writeFileSync(path.join(RV, "env"), "OPENAI_API_KEY=sk-from-file\nOPENAI_MODEL=gpt-6-astra-file\n");
  r = run(DRAFT, ["--backend", "openai"], { OPENAI_API_KEY: undefined });
  eq("key + model from ~/.revoice/env", [r.code, last().auth, body().model], [0, "Bearer sk-from-file", "gpt-6-astra-file"]);
  fs.rmSync(path.join(RV, "env"));
  r = run(DRAFT, ["--backend", "openai", "--instruction", "shorter", "--style", "casual"]);
  eq("style + instruction land in the system prompt, draft stays the user message", [body().messages[0].content.includes("Additional instruction: shorter"), body().messages[0].content.includes("FULL VOICE GUIDE"), body().messages[1].content], [true, false, DRAFT]);

  r = run(DRAFT, ["--backend", "openai"], { OPENAI_REASONING_EFFORT: "off" });
  eq("OPENAI_REASONING_EFFORT=off: field omitted (non-reasoning OPENAI_MODEL)", [r.code, "reasoning_effort" in body(), Object.keys(body()).sort(), r.err], [0, false, ["messages", "model"], "via:openai"]);

  // ---- streaming ----
  r = run(DRAFT, ["--backend", "openai", "--stream"], {}, { reply: "Can you send the Q3 SOW over today? Thanks." });
  eq("--stream: stream:true in body, deltas concatenated on stdout, via:openai", [r.code, body().stream, r.out, r.err], [0, true, "Can you send the Q3 SOW over today? Thanks.", "via:openai"]);
  r = run(DRAFT, ["--backend", "openai"], {}, { reply: "  Trimmed.  \n" });
  eq("non-stream: output trimmed", r.out, "Trimmed.");

  r = run(DRAFT, ["--backend", "openai,kimi", "--stream"], { KIMI_API_KEY: "k", KIMI_API_URL: "http://127.0.0.1:4713" }, { reply: "Please send the SOW.", truncate: true });
  eq("stream closes before [DONE]: partial stays on stdout, exit 1, exact error, NO fallback to kimi", [r.code, r.out, r.err, calls(KIMI_LOG).length], [1, "Please sen", "openai: OpenAI stream ended before [DONE]", 0]);
  r = run(DRAFT, ["--backend", "openai", "--stream"], {}, { reply: "", truncate: true });
  eq("stream with no text and no [DONE]: exit 1, ended-early error (not 'empty result')", [r.code, r.out, r.err], [1, "", "openai: OpenAI stream ended before [DONE]"]);
  const t0 = Date.now();
  // openai answers at 12s, the deadline makes it time out at 10s, kimi is refused, ollama takes 3s more:
  // without an abort, openai's late chunk would land on stdout while ollama is still working.
  r = run(DRAFT, ["--backend", "openai,kimi,ollama", "--stream"], { KIMI_API_KEY: "k", KIMI_API_URL: "http://127.0.0.1:1", REWRITE_TIMEOUT_MS: "1000" }, { delay: 12000, ollamaDelay: 3000 });
  eq("openai silent past the deadline: timed out + aborted, ollama's output alone on stdout", [r.code, r.out, r.err.split("\n").at(-1), r.err.includes("openai: OpenAI timed out after 10000ms"), fs.readFileSync(path.join(T, "openai-aborted.log"), "utf8").trim(), Date.now() - t0 < 16000], [0, "OLLAMA: " + FRAMED, "via:ollama", true, "client aborted before response", true]);

  // ---- reply mode with images ----
  r = run("friday works", ["--backend", "openai", "--reply", "--image", PNG, "--context", "Can you meet Thursday?"]);
  const u = body().messages[1].content;
  eq("reply+image: user content = [text brief, image_url data URL]", [r.code, Array.isArray(u), u.length, u[0].type, u[0].text.includes("Can you meet Thursday?") && u[0].text.includes("friday works"), u[1]], [0, true, 2, "text", true, { type: "image_url", image_url: { url: "data:image/png;base64," + fs.readFileSync(PNG).toString("base64") } }]);
  eq("reply+image: still gpt-6-astra with reasoning_effort", [body().model, body().reasoning_effort], ["gpt-6-astra", "low"]);

  // ---- error paths ----
  r = run(DRAFT, ["--backend", "openai"], { OPENAI_API_KEY: undefined });
  eq("explicit openai without key: exit 1, exact error, no request", [r.code, r.out, r.err, calls().length], [1, "", "openai: OPENAI_API_KEY not set", 0]);
  r = run(DRAFT, ["--backend", "openai"], {}, { status: 401 });
  eq("HTTP 401: exit 1, error carries status + body", [r.code, r.out, r.err], [1, "", 'openai: OpenAI API 401: {"error":{"message":"fake failure 401","type":"invalid_request_error"}}']);
  r = run(DRAFT, ["--backend", "openai"], { OPENAI_API_URL: "http://127.0.0.1:1/v1" });
  eq("unreachable host: exit 1, error names the exact URL + a cause", [r.code, r.out, r.err.startsWith("openai: OpenAI request to http://127.0.0.1:1/v1/chat/completions failed: "), r.err.length > "openai: OpenAI request to http://127.0.0.1:1/v1/chat/completions failed: ".length], [1, "", true, true]);
  r = run(DRAFT, ["--backend", "openai"], {}, { reply: "   " });
  eq("blank content: exit 1 'returned empty result'", [r.code, r.out, r.err], [1, "", "openai: OpenAI returned empty result"]);
  r = run(DRAFT, ["--backend", "openai", "--stream"], {}, { reply: "" });
  eq("blank streamed content: exit 1, nothing on stdout", [r.code, r.out, r.err], [1, "", "openai: OpenAI returned empty result"]);
  r = run(DRAFT, ["--backend", "openai"], {}, { status: 500 });
  eq("explicit openai 500: no fallback to kimi/ollama", [r.code, calls(KIMI_LOG).length, calls(OLLAMA_LOG).length], [1, 0, 0]);

  // ---- auto chain placement ----
  r = run(DRAFT, [], { OPENAI_API_KEY: undefined, KIMI_API_KEY: undefined });
  eq("auto, no keys: openai + kimi skipped, lands on ollama", [r.code, calls().length, calls(KIMI_LOG).length, calls(OLLAMA_LOG).length, r.err.split("\n").at(-1)], [0, 0, 0, 1, "via:ollama"]);
  r = run(DRAFT, [], { KIMI_API_KEY: "k", KIMI_API_URL: "http://127.0.0.1:4713" });
  eq("auto, both keys: openai answers before kimi/ollama (codex/claude failed first)", [r.code, r.out, calls().length, calls(KIMI_LOG).length, calls(OLLAMA_LOG).length, r.err.endsWith("via:openai")], [0, "OPENAI: " + DRAFT.slice(0, 40), 1, 0, 0, true]);
  r = run(DRAFT, [], { KIMI_API_KEY: "k", KIMI_API_URL: "http://127.0.0.1:4713" }, { status: 503 });
  eq("auto, openai 503: falls through to kimi, error recorded in stderr", [r.code, r.out, calls(KIMI_LOG).length, r.err.endsWith("via:kimi")], [0, "KIMI: " + DRAFT.slice(0, 40), 1, true]);
  r = run(DRAFT, ["--backend", "codex,openai"]);
  eq("explicit chain codex,openai: codex missing → openai answers, via:openai", [r.code, r.out, r.err.endsWith("via:openai")], [0, "OPENAI: " + DRAFT.slice(0, 40), true]);
  r = run(DRAFT, ["--backend", "openai,ollama"], {}, { status: 500 });
  eq("auto-fallback warning names the failed openai call", [r.code, r.err.split("\n")[0]], [0, 'revoice: openai: OpenAI API 500: {"error":{"message":"fake failure 500","type":"invalid_request_error"}} — falling back to local Ollama (llama3.2:3b)']);

  // ---- kimi unaffected (shared implementation, separate provider) ----
  r = run(DRAFT, ["--backend", "kimi"], { KIMI_API_KEY: "kimi-key", KIMI_API_URL: "http://127.0.0.1:4714", KIMI_MODEL: "moonshot-x", KIMI_TEMPERATURE: "0.3" });
  eq("kimi: own key/model/temperature, no reasoning_effort, via:kimi", [r.code, last().auth, body().model, body().temperature, "reasoning_effort" in body(), r.err], [0, "Bearer kimi-key", "moonshot-x", 0.3, false, "via:kimi"]);
  r = run(DRAFT, ["--backend", "kimi"], { KIMI_API_KEY: undefined });
  eq("kimi: own missing-key error", [r.code, r.err], [1, "kimi: KIMI_API_KEY not set"]);
  r = run(DRAFT, ["--backend", "kimi"], { KIMI_API_KEY: "k", KIMI_API_URL: "http://127.0.0.1:4714" }, { status: 429 });
  eq("kimi: errors still say Kimi", r.err, 'kimi: Kimi API 429: {"error":{"message":"fake failure 429","type":"invalid_request_error"}}');

  // ---- doctor / help ----
  r = run("", ["--doctor"]);
  const line = (k) => r.out.split("\n").find((l) => l.startsWith(k));
  eq("doctor: openai line with url/model/effort, exit 0 on key alone", [r.code, line("openai:"), line("backend chain:")], [0, "openai: key set  (http://127.0.0.1:4714/v1, model gpt-6-astra, effort low)", "backend chain: claude → codex → openai → kimi → ollama  (REWRITE_BACKEND=<unset>)"]);
  r = run("", ["--doctor"], { OPENAI_API_KEY: undefined });
  eq("doctor: no key → hint, exit 1 when nothing else configured", [r.code, line("openai:")], [1, "openai: no OPENAI_API_KEY (optional: paid API, faster than codex)"]);
  r = run("", ["--help"]);
  eq("help lists openai", r.out.includes("--backend auto|claude|codex|openai|kimi|ollama|CHAIN"), true);
} finally {
  srv.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
