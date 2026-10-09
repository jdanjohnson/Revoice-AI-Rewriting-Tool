#!/usr/bin/env node
// Ambiguity-flag contract (bin/revoice.js), against the fake OpenAI in fake-servers.mjs.
// Contract: the system prompt ends with the FLAGS instruction; a trailing `FLAGS: a | b` line
// (any case, `|`/bullet/newline separated, `none` ignored) is removed from stdout and each
// flag is printed on stderr as `flag:<text>`; with --stream the rewrite is forwarded line by
// line and a line that starts like FLAGS: is held back so it never reaches stdout, while a
// held-back partial line that turns out to be ordinary text is still emitted.
// Run: `npm test flags`
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "revoice.js");
const T = path.join(HERE, ".tmp-flags");
fs.rmSync(T, { recursive: true, force: true });
const HOME = path.join(T, "home");
const RV = path.join(HOME, ".revoice");
fs.mkdirSync(RV, { recursive: true });
fs.writeFileSync(path.join(RV, "prompt.txt"), "VOICE GUIDE.");
const LOG = path.join(T, "openai.log");

const srv = spawn(process.execPath, [path.join(HERE, "fake-servers.mjs"), T], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res) => srv.stdout.on("data", (d) => /ready/.test(String(d)) && res()));

const env = { HOME, PATH: process.env.PATH, OPENAI_API_URL: "http://127.0.0.1:4714/v1", OPENAI_API_KEY: "sk-test", REWRITE_BACKEND: "openai" };
function run(reply, args = []) {
  fs.rmSync(LOG, { force: true });
  fs.writeFileSync(path.join(T, "openai.reply"), reply);
  const r = spawnSync(process.execPath, [CLI, ...args], { input: "send it to them by friday", env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, flags: r.stderr.split("\n").filter((l) => l.startsWith("flag:")).map((l) => l.slice(5)) };
}
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS  " + name); } else { fail++; console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// prompt contract
let r = run("Send it to them by Friday.");
const sys = JSON.parse(fs.readFileSync(LOG, "utf8").trim().split("\n").pop()).body.messages[0].content;
eq("system prompt ends with the FLAGS instruction (after the voice guide)", [sys.startsWith("VOICE GUIDE."), sys.endsWith("If nothing could change the meaning, add nothing after the rewrite."), sys.includes("FLAGS: <ambiguity> | <ambiguity>")], [true, true, true]);
eq("no FLAGS line -> stdout is the rewrite verbatim, no flag lines", [r.code, r.out, r.flags], [0, "Send it to them by Friday.", []]);

// strip + report
r = run('Send it to them by Friday.\nFLAGS: who is "them" — legal or the client? | this Friday or next?');
eq("FLAGS line stripped from stdout (no trailing newline)", r.out, "Send it to them by Friday.");
eq("flags reported on stderr in order, after via:", [r.flags, r.err.indexOf("via:openai") < r.err.indexOf("flag:")], [['who is "them" — legal or the client?', "this Friday or next?"], true]);
r = run("Line one.\nLine two.\n\nflags:\n- who is them\n* which friday\n");
eq("lower-case + bulleted multi-line flags; blank line before FLAGS trimmed", [r.out, r.flags], ["Line one.\nLine two.", ["who is them", "which friday"]]);
r = run("Send it by Friday.\nFLAGS: none");
eq("FLAGS: none -> no flags, line still stripped", [r.out, r.flags], ["Send it by Friday.", []]);
r = run("Send it by Friday.\nFlag: N/A.");
eq("singular Flag: + N/A. -> no flags", [r.out, r.flags], ["Send it by Friday.", []]);
r = run("Step 1: FLAGS: are not this\nDone.");
eq("a mid-line 'FLAGS:' is not a flags line", [r.out, r.flags], ["Step 1: FLAGS: are not this\nDone.", []]);
r = run("Send it by Friday.\nFLAGS: a | b", ["--log-history"]);
const hist = JSON.parse(fs.readFileSync(path.join(RV, "history.jsonl"), "utf8").trim().split("\n").pop());
eq("history entry stores the stripped rewrite + flags", [hist.rewrite, hist.flags], ["Send it by Friday.", ["a", "b"]]);

// streaming: the fake server sends the content as two SSE deltas split at ceil(len/2)
const splitAt = (s) => Math.ceil(s.length / 2);
let body = "Send it by Friday ok\nFLAGS: who is them | which day";
let cut = splitAt(body);
eq("fixture: the chunk boundary splits the word FLAGS: itself", cut > body.indexOf("FLAGS:") && cut < body.indexOf("FLAGS:") + 6, true);
r = run(body, ["--stream"]);
eq("stream: stdout = rewrite (+ its newline), FLAGS never streamed", [r.out, r.out.includes("FLAG"), r.flags], ["Send it by Friday ok\n", false, ["who is them", "which day"]]);
body = "First line of the rewrite is here.\nF";  // boundary leaves a lone "F" that could start FLAGS:
cut = splitAt(body);
r = run(body, ["--stream"]);
eq("stream: held-back 'F' that is ordinary text is still emitted", [r.out, r.flags], ["First line of the rewrite is here.\nF", []]);
body = "Alpha line.\nBeta line continues Flags: not a flag\nGamma.";
r = run(body, ["--stream"]);
eq("stream: 'Flags:' mid-line is forwarded as text", [r.out, r.flags], [body, []]);
body = "Note the FLAGS:\n";  // 16 chars: chunk 1 = "Note the", chunk 2 = " FLAGS:\n" (mid-line, not a flags line)
eq("fixture: chunk boundary right before ' FLAGS:'", splitAt(body), body.indexOf(" FLAGS:"));
r = run(body, ["--stream"]);
eq("stream: a chunk that starts with ' FLAGS:' mid-line is text, not flags", [r.out, r.flags], ["Note the FLAGS:\n", []]);
body = "Short.\nFLAGS: x";
r = run(body, ["--stream"]);
eq("stream: FLAGS delivered in a later chunk than the rewrite is still caught", [r.out, r.flags], ["Short.\n", ["x"]]);

srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
