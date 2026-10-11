#!/usr/bin/env node
// Runs every suite in test/ and exits non-zero if any assertion failed.
// Node suites run sequentially (they share fixed fake-server ports); the
// Hammerspoon suites need `lua` (5.3+) and are skipped with a warning without it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const pick = (f) => !only.length || only.some((o) => f.includes(o));

const results = [];
function record(name, r) {
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  const m = out.match(/(\d+) passed, (\d+) failed/);
  // a suite that crashed mid-way prints no summary line: count its PASS/FAIL lines instead
  const passed = m ? +m[1] : (out.match(/^PASS  /gm) || []).length;
  const failed = m ? +m[2] : (out.match(/^FAIL  /gm) || []).length;
  const ok = r.status === 0 && !!m && failed === 0;
  results.push({ name, passed, failed, ok, status: r.status });
}

for (const f of fs.readdirSync(HERE).filter((f) => f.endsWith(".test.mjs") && pick(f)).sort()) {
  console.log(`\n### ${f}`);
  record(f, spawnSync(process.execPath, [path.join(HERE, f)], { encoding: "utf8", timeout: 600_000 }));
}

const lua = ["lua", "lua5.4", "lua5.3"].find((b) => spawnSync(b, ["-v"], { encoding: "utf8" }).status === 0);
const luaSuites = fs.readdirSync(HERE).filter((f) => f.endsWith(".test.lua") && pick(f)).sort();
if (!lua && luaSuites.length) console.log(`\n(skipping ${luaSuites.length} Hammerspoon suite(s): no lua interpreter on PATH)`);
if (lua) {
  for (const f of luaSuites) {
    console.log(`\n### ${f} (${lua})`);
    // fresh scratch HOME per suite (the suites simulate a first install); created here with
    // fs calls so the path never goes through a shell
    const home = path.join(HERE, `.tmp-hs-${f.replace(/\W/g, "-")}`);
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, ".revoice", "bin"), { recursive: true });
    record(f, spawnSync(lua, [path.join(HERE, f)], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 120_000 }));
  }
}

console.log("\n==== summary ====");
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(30)} ${r.passed} passed, ${r.failed} failed${r.status !== 0 ? ` (exit ${r.status})` : ""}`);
}
if (!results.length) { console.log("no suites matched"); process.exit(1); }
process.exit(bad ? 1 : 0);
