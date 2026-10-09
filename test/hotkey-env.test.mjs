// Contract under test:
//  A) ~/.revoice/env loader: real process env wins over the file; within the
//     file the LAST assignment of a key wins (so `>>` appends override).
//  B) `revoice --doctor`: prints effective chain, resolved codex/claude paths
//     (or NOT FOUND), kimi key state, ollama url, PATH; exit 0 iff some
//     non-ollama backend is usable.
//  C) Chain fallback under a bare PATH: with codex,claude unreachable the CLI
//     lands on ollama — the bug the Hammerspoon PATH fix addresses.
// Failure modes: first-wins regression (A1), env override lost (A2), quoted
// values / comments (A3), doctor false-positive on missing binary (B1),
// CODEX_BIN honoured (B2), exit code (B3), PATH scan finds npm-global codex (B4).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "revoice.js");
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const mk = (envText) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rv-"));
  fs.mkdirSync(path.join(home, ".revoice", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, "npmbin"));
  if (envText != null) fs.writeFileSync(path.join(home, ".revoice", "env"), envText);
  return home;
};
const run = (home, args, extraEnv = {}, PATH = "/usr/bin:/bin") => {
  const r = spawnSync("node", [CLI, ...args], { env: { HOME: home, PATH, ...extraEnv }, encoding: "utf8" });
  return { out: r.stdout.trim().split("\n"), code: r.status };
};
const line = (out, prefix) => out.find((l) => l.startsWith(prefix)) || "";

// A1: last line wins
let h = mk("REWRITE_BACKEND=codex,claude,kimi,ollama\nREWRITE_BACKEND=codex\n");
let r = run(h, ["--doctor"]);
eq("A1 last assignment in env file wins", line(r.out, "backend chain"), "backend chain: codex  (REWRITE_BACKEND=codex)");
// A2: real env beats file
r = run(h, ["--doctor"], { REWRITE_BACKEND: "kimi" });
eq("A2 process env overrides file", line(r.out, "backend chain"), "backend chain: kimi  (REWRITE_BACKEND=kimi)");
// A3: quoted value + trailing comment + export prefix
h = mk('export REWRITE_BACKEND="claude" # try first\nOLLAMA_MODEL=qwen:7b   # small\n');
r = run(h, ["--doctor"]);
eq("A3 quoted/export/comment parsing", [line(r.out, "backend chain"), line(r.out, "ollama:")],
  ["backend chain: claude  (REWRITE_BACKEND=claude)", "ollama: http://127.0.0.1:11434  (model qwen:7b)"]);
// A4: no env file → auto chain
h = mk(null);
r = run(h, ["--doctor"]);
eq("A4 missing env file → auto chain", line(r.out, "backend chain"), "backend chain: claude → codex → kimi → ollama  (REWRITE_BACKEND=<unset>)");

// B1: bare PATH, nothing installed → NOT FOUND + exit 1 (what Hammerspoon saw)
h = mk("REWRITE_BACKEND=codex\n");
r = run(h, ["--doctor"]);
eq("B1 codex NOT FOUND on bare PATH", line(r.out, "codex:").startsWith("codex:  NOT FOUND"), true);
eq("B1 claude NOT FOUND on bare PATH", line(r.out, "claude:").startsWith("claude: NOT FOUND"), true);
eq("B1 exit 1 when only ollama is usable", r.code, 1);
eq("B1 PATH echoed", line(r.out, "PATH:"), "PATH:   /usr/bin:/bin");
// B4: codex on an npm-global dir that only the login shell PATH has
const codexBin = path.join(h, "npmbin", "codex");
fs.writeFileSync(codexBin, "#!/bin/sh\necho hi\n"); fs.chmodSync(codexBin, 0o755);
r = run(h, ["--doctor"], {}, `${path.join(h, "npmbin")}:/usr/bin:/bin`);
eq("B4 codex found via PATH scan", line(r.out, "codex:"), `codex:  ${codexBin}  (model gpt-6-astra)`);
eq("B4 exit 0 when codex usable", r.code, 0);
// B2: CODEX_BIN from env file, bare PATH
fs.appendFileSync(path.join(h, ".revoice", "env"), `CODEX_BIN=${codexBin}\nCODEX_MODEL=gpt-6-mini\n`);
r = run(h, ["--doctor"]);
eq("B2 CODEX_BIN from env file honoured with bare PATH", line(r.out, "codex:"), `codex:  ${codexBin}  (model gpt-6-mini)`);
// B3: non-executable file is not accepted by PATH scan
const dud = mk("REWRITE_BACKEND=codex\n");
fs.writeFileSync(path.join(dud, "npmbin", "codex"), "x"); fs.chmodSync(path.join(dud, "npmbin", "codex"), 0o644);
r = run(dud, ["--doctor"], {}, `${path.join(dud, "npmbin")}:/usr/bin:/bin`);
eq("B3 non-executable codex on PATH ignored", line(r.out, "codex:").startsWith("codex:  NOT FOUND"), true);
// B5: kimi key → exit 0
r = run(dud, ["--doctor"], { KIMI_API_KEY: "k" });
eq("B5 kimi key reported + exit 0", [line(r.out, "kimi:"), r.code], ["kimi:   key set  (https://api.moonshot.ai/v1, model moonshot-v1-auto)", 0]);
// B6: --help lists --doctor
r = run(dud, ["--help"]);
eq("B6 --help mentions --doctor", r.out[0].includes("[--doctor]"), true);

// C: forced codex with bare PATH fails hard (no silent ollama) — explicit single backend
h = mk("REWRITE_BACKEND=codex\n");
const c = spawnSync("node", [CLI], { input: "hi", env: { HOME: h, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
eq("C1 forced codex + bare PATH → hard error mentioning codex not found", [c.status !== 0, /codex CLI not found/.test(c.stderr)], [true, true]);
// C2: chain codex,ollama with bare PATH and unreachable ollama → error names ollama (fell through)
h = mk("REWRITE_BACKEND=codex,ollama\nOLLAMA_URL=http://127.0.0.1:1\n");
const c2 = spawnSync("node", [CLI], { input: "hi", env: { HOME: h, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
eq("C2 chain falls through codex→ollama on bare PATH", [c2.status !== 0, /codex/.test(c2.stderr) && /ollama/i.test(c2.stderr)], [true, true]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
