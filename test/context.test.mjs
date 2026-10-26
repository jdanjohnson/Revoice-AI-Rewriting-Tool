#!/usr/bin/env node
// Context gathering, mode, and Zo allowlist tests using only local fake servers.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "bin", "revoice.js");
const T = path.join(HERE, ".tmp-context");
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const HOME = path.join(T, "home");
fs.mkdirSync(path.join(HOME, ".revoice", "context"), { recursive: true });
const CONTEXT = path.join(HOME, ".revoice", "context");
const FAKE_CODEX_LOG = path.join(T, "codex.log");
const FAKE_CODEX = path.join(T, "codex");
fs.writeFileSync(FAKE_CODEX, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv }) + "\\n");
const i = argv.indexOf("--output-last-message");
fs.writeFileSync(argv[i + 1], "FAKE-OUTPUT");
`, { mode: 0o755 });
const FAKE_IMAGE = path.join(T, "screenshot.png");
fs.writeFileSync(FAKE_IMAGE, "fake screenshot");
const FAKE_GOLDFISH = path.join(T, "goldfish-mcp");
fs.writeFileSync(FAKE_GOLDFISH, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop();
  for (const line of lines) {
    if (!line) continue;
    const message = JSON.parse(line);
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-goldfish", version: "1.0.0" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "search_activity", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: "Alex Example appeared in recent screen activity." }] };
    } else {
      continue;
    }
    if (message.id !== undefined)
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`, { mode: 0o755 });
const FAKE_GOLDFISH_EXIT = path.join(T, "goldfish-exits");
fs.writeFileSync(FAKE_GOLDFISH_EXIT, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });

const server = spawn(process.execPath, [path.join(HERE, "fake-servers.mjs"), T], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  let out = "";
  server.stdout.on("data", (chunk) => {
    out += chunk;
    if (out.includes("zo-ready")) resolve();
  });
  server.once("error", reject);
});
process.on("exit", () => server.kill());

process.env.HOME = HOME;
process.env.REVOICE_ZO_TOKEN = "test-token";
process.env.REVOICE_ZO_URL = "http://127.0.0.1:4715/sse";
const { zoCall, computeFreeSlots } = await import("../bin/revoice.js");

const baseEnv = {
  PATH: "/usr/bin:/bin",
  HOME,
  CODEX_BIN: FAKE_CODEX,
  FAKE_CODEX_LOG,
  REWRITE_BACKEND: "codex",
  REWRITE_PROMPT_FILE: path.join(T, "prompt.txt"),
  REWRITE_SKILLS_DIR: path.join(T, "skills"),
  REWRITE_STYLES_DIR: path.join(T, "styles"),
  VOICE_SAMPLES_FILE: path.join(T, "samples.txt"),
  OLLAMA_URL: "http://127.0.0.1:4711",
  REVOICE_ZO_TOKEN: "test-token",
  REVOICE_ZO_URL: "http://127.0.0.1:4715",
  REVOICE_CALENDARS: "owner@example.com",
  REVOICE_TZ: "America/New_York",
  REVOICE_WORK_HOURS: "9-18",
  REVOICE_NOW: "2026-10-26T08:05:00-04:00",
};
fs.writeFileSync(baseEnv.REWRITE_PROMPT_FILE, "TEST PROMPT: rewrite.");
fs.mkdirSync(baseEnv.REWRITE_SKILLS_DIR);
fs.mkdirSync(baseEnv.REWRITE_STYLES_DIR);
fs.writeFileSync(baseEnv.VOICE_SAMPLES_FILE, "");

let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      ${detail}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got  ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`);
}
function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}
function run(input, args, extra = {}) {
  fs.rmSync(FAKE_CODEX_LOG, { force: true });
  fs.rmSync(path.join(T, "zo.log"), { force: true });
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input,
    env: { ...baseEnv, ...extra },
    encoding: "utf8",
    timeout: 15000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
function prompt() {
  const entry = JSON.parse(lines(FAKE_CODEX_LOG).at(-1));
  return entry.argv.at(-1);
}
const emptyHome = (includeLocal = false) => {
  fs.rmSync(CONTEXT, { recursive: true, force: true });
  fs.mkdirSync(CONTEXT, { recursive: true });
  if (includeLocal) {
    fs.writeFileSync(path.join(CONTEXT, "about-me.md"), "About the author.\n");
    fs.writeFileSync(path.join(CONTEXT, "notes.md"), "Local durable note.\n");
  }
};

// Invalid tools are rejected before initialize can reach the fake endpoint.
{
  fs.rmSync(path.join(T, "zo.log"), { force: true });
  let errors = [];
  for (const [tool, args] of [
    ["bash", {}],
    ["use_app_gmail", {}],
    ["use_app_google_calendar", { tool_name: "google_calendar-create-event" }],
  ]) {
    try { await zoCall(tool, args); } catch (error) { errors.push(error.message); }
  }
  eq("Zo allowlist rejects disallowed tools", errors, [
    "zo tool not allowed: bash",
    "zo tool not allowed: use_app_gmail",
    "zo tool not allowed: use_app_google_calendar",
  ]);
  eq("allowlist rejects before any network request", lines(path.join(T, "zo.log")), []);
}

// A valid Zo call exercises SSE parsing, bearer auth, and MCP session reuse.
{
  const text = await zoCall("read_file", { target_file: "/home/workspace/Records/Context/you.md" });
  check("Zo SSE response yields read_file text", text.includes("YOU CARD"), text);
  const calls = lines(path.join(T, "zo.log")).map(JSON.parse);
  eq("Zo handshake and tool call use one authenticated session", calls.map((c) => c.method), [
    "initialize", "notifications/initialized", "tools/call",
  ]);
  check("Zo authorization header is bearer token", calls.every((c) => c.authorization === "Bearer test-token"), JSON.stringify(calls));
  check("Zo session id is echoed on the tool call", calls[2].session === "fake-session", JSON.stringify(calls[2]));
}

// Reply: local, Zoey, contact, and read-only free/busy context.
{
  emptyHome(true);
  const result = run("", [
    "--backend", "codex", "--reply", "--context",
    "Alex Example <alex@example.com> asked: can we meet next week?",
  ]);
  eq("reply with context succeeds without notes", [result.code, result.out], [0, "FAKE-OUTPUT"]);
  const assembled = prompt();
  for (const expected of [
    "PERSONAL CONTEXT",
    "About the author.",
    "Local durable note.",
    "YOU CARD",
    "ALEX DOSSIER",
    "MY REAL AVAILABILITY",
    "Mon Oct 26",
    "Tue Oct 27",
  ]) check(`reply context includes ${expected}`, assembled.includes(expected), assembled);
  check("availability does not propose a time inside a busy interval",
    !assembled.includes("9:00 AM–10:00 AM") && !assembled.includes("2:00 PM–5:00 PM"), assembled);
  check("complete calendar availability enables the proposal instruction",
    assembled.includes("propose 2–3 concrete times from MY REAL AVAILABILITY"), assembled);
  check("reply includes no-notes instruction",
    assembled.includes("no notes given — infer the natural, useful reply"), assembled);
  check("reply context sources are tagged", [
    "context:about-me", "context:notes", "context:zoey", "context:contacts", "context:calendar",
  ].every((tag) => result.err.includes(tag)), result.err);
  check("Zoey card refresh is cached", fs.readFileSync(path.join(CONTEXT, "zoey.md"), "utf8").includes("YOU CARD"));
  const calls = lines(path.join(T, "zo.log")).map(JSON.parse);
  check("Zo calls only read_file and free-busy", calls.every((call) =>
    call.method !== "tools/call" ||
    call.name === "read_file" ||
    (call.name === "use_app_google_calendar" &&
      call.arguments.tool_name === "google_calendar-query-free-busy-calendars")
  ), JSON.stringify(calls));
}

// Failed calendars are disclosed, while other context and the reply still work.
{
  emptyHome();
  fs.writeFileSync(path.join(T, "zo.fail-account"), "offline@example.com");
  const result = run("ok", ["--backend", "codex", "--reply", "--context", "Can we schedule a call?"],
    { REVOICE_CALENDARS: "offline@example.com,owner@example.com" });
  eq("one failed calendar does not fail reply", [result.code, result.out], [0, "FAKE-OUTPUT"]);
  check("failed calendar withholds all availability slots",
    prompt().includes("Calendar availability unavailable (could not read: offline@example.com); do not propose specific times.") &&
      !prompt().includes("Mon Oct 26,") && !prompt().includes("Tue Oct 27,"), prompt());
  check("failed calendar suppresses proposal instruction",
    !prompt().includes("propose 2–3 concrete times"), prompt());
  fs.rmSync(path.join(T, "zo.fail-account"), { force: true });
}

// A screenshot-only reply gets calendar context even without meeting keywords in the text.
{
  emptyHome();
  const result = run("", ["--backend", "codex", "--reply", "--image", FAKE_IMAGE]);
  eq("screenshot-only reply succeeds", [result.code, result.out], [0, "FAKE-OUTPUT"]);
  check("screenshot-only reply gathers availability",
    prompt().includes("MY REAL AVAILABILITY") && prompt().includes("Mon Oct 26,"), prompt());
}

// Goldfish activity is queried before contacts, so on-screen names can resolve to contact cards.
{
  emptyHome();
  const result = run("", ["--backend", "codex", "--reply", "--image", FAKE_IMAGE],
    { GOLDFISH_MCP: FAKE_GOLDFISH, REVOICE_CALENDARS: "" });
  eq("reply with Goldfish context succeeds", [result.code, result.out], [0, "FAKE-OUTPUT"]);
  check("Goldfish response becomes context", prompt().includes("Alex Example appeared in recent screen activity."), prompt());
  check("Goldfish name triggers contact lookup", prompt().includes("ALEX DOSSIER"), prompt());
}

// An early Goldfish exit is a warning, not a failed draft.
{
  emptyHome();
  const result = run("A short reply.", ["--backend", "codex", "--reply"],
    { GOLDFISH_MCP: FAKE_GOLDFISH_EXIT, REVOICE_CALENDARS: "" });
  eq("early Goldfish exit does not fail reply", [result.code, result.out], [0, "FAKE-OUTPUT"]);
  check("early Goldfish exit is logged as skipped", result.err.includes("context goldfish skipped"), result.err);
}

// A fully booked seven-day window must not leak next Monday's slots.
{
  const now = new Date("2026-10-26T08:05:00-04:00").getTime();
  const until = now + 7 * 86400000;
  const slots = computeFreeSlots({
    now,
    until,
    busy: [[now, until]],
    timeZone: "America/New_York",
    workHours: "9-18",
  });
  eq("fully busy 7-day window has no day-8 slot", slots, []);
}

// Plain rewrite keeps local context but never contacts Zo; context-off disables both.
{
  emptyHome(true);
  const result = run("Rewrite this draft.", ["--backend", "codex"]);
  eq("plain rewrite succeeds", result.code, 0);
  check("plain rewrite includes local about-me and notes", prompt().includes("About the author.") && prompt().includes("Local durable note."), prompt());
  eq("plain rewrite makes no Zo requests", lines(path.join(T, "zo.log")), []);
  const off = run("Rewrite this draft.", ["--backend", "codex"], { REVOICE_CONTEXT: "off" });
  check("context-off removes personal context", !prompt().includes("PERSONAL CONTEXT"), prompt());
  eq("context-off makes no Zo requests", lines(path.join(T, "zo.log")), []);
  check("context-off rewrite succeeds", off.code === 0, JSON.stringify(off));
}

// Prompt and ask modes carry their briefs and history mode; conflicting flags reject.
{
  emptyHome();
  let result = run("Build me a prompt for a release note.", ["--backend", "codex", "--prompt", "--log-history"]);
  check("--prompt brief reaches backend", result.code === 0 && prompt().includes("PROMPT MODE") &&
    prompt().includes("Build me a prompt for a release note."), prompt());
  const hist = path.join(HOME, ".revoice", "history.jsonl");
  check("--prompt history preserves mode", JSON.parse(fs.readFileSync(hist, "utf8").trim()).mode === "prompt");
  result = run("What is in the context?", ["--backend", "codex", "--ask"]);
  check("--ask brief reaches backend", result.code === 0 && prompt().includes("ASK MODE"), prompt());
  result = run("x", ["--backend", "codex", "--prompt", "--reply"]);
  eq("--prompt and --reply are mutually exclusive", [result.code, result.err.trim()], [
    1, "revoice: --reply, --prompt, and --ask are mutually exclusive",
  ]);
  emptyHome();
  result = run("", ["--backend", "codex", "--reply"], { REVOICE_ZO_TOKEN: "" });
  eq("empty reply with no context fails with intended error", [result.code, result.err.trim()], [
    1, "revoice: nothing to reply to",
  ]);
}

// Remember/status are local operations; status must not reveal account values.
{
  emptyHome();
  let result = run("", ["--remember", "Use concise explanations."], { REVOICE_ZO_TOKEN: "" });
  eq("--remember confirms completion", [result.code, result.out.trim()], [0, "remembered"]);
  check("--remember appends a dated note", /^- \d{4}-\d{2}-\d{2} Use concise explanations\.\n$/.test(
    fs.readFileSync(path.join(CONTEXT, "notes.md"), "utf8")
  ));
  result = run("", ["--context-status"], { REVOICE_ZO_TOKEN: "" });
  check("--context-status reports local file state", result.out.includes("notes.md:") && result.out.includes("about-me.md: missing"));
  check("--context-status reports token and calendar configuration", result.out.includes("zoey: token not set") &&
    result.out.includes("calendars: 1 accounts configured"), result.out);
  check("--context-status doesn't display configured calendar address", !result.out.includes("owner@example.com"), result.out);
}

// Exercise deterministic weekday slots directly, including the next half-hour boundary.
{
  const slots = computeFreeSlots({
    now: new Date("2026-10-26T08:05:00-04:00").getTime(),
    busy: [[Date.parse("2026-10-26T09:00:00-04:00"), Date.parse("2026-10-26T10:00:00-04:00")]],
    timeZone: "America/New_York",
    workHours: "9-18",
  });
  check("free slot math returns human-readable weekday availability",
    slots.length > 0 && slots[0].startsWith("Mon Oct 26,"), JSON.stringify(slots));
  check("free slot starts on a half-hour boundary", !slots[0]?.includes("9:00 AM"), JSON.stringify(slots));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
