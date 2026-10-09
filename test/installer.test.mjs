#!/usr/bin/env node
// Contract for the one-line installer + `revoice --update` (install.sh, bin/revoice.js).
// Piped install (no checkout next to the script): clone REVOICE_REPO into ~/.revoice/src (or
// `git pull --ff-only` if present) and exec that install.sh; install.sh records its own dir in
// ~/.revoice/src-path. `--update` pulls that checkout and re-runs its install.sh, failing with a
// hint when src-path is missing/stale/not a git checkout, and NOT reinstalling when the pull fails.
// Linux/CI: a fake `brew` on PATH stands in for `brew install --cask hammerspoon` so install.sh runs to the end.
// Run: `npm test installer`
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const T = path.join(HERE, ".tmp-installer");
fs.rmSync(T, { recursive: true, force: true });
const HOME = path.join(T, "home");
const RV = path.join(HOME, ".revoice");
const FAKEBIN = path.join(T, "fakebin");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(FAKEBIN);
fs.writeFileSync(path.join(FAKEBIN, "brew"), "#!/bin/sh\necho fake-brew \"$@\"\n");
fs.chmodSync(path.join(FAKEBIN, "brew"), 0o755);
const env = { HOME, PATH: `${FAKEBIN}:${process.env.PATH}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cmd, opts = {}) => spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd || T, input: opts.input });

// a local "GitHub": bare origin with the current checkout's installer files
const ORIGIN = path.join(T, "origin.git");
const WORK = path.join(T, "work");
fs.mkdirSync(WORK);
for (const f of ["install.sh", "package.json", "bin/revoice.js", "hammerspoon/revoice.lua"]) {
  fs.mkdirSync(path.dirname(path.join(WORK, f)), { recursive: true });
  fs.copyFileSync(path.join(REPO, f), path.join(WORK, f));
}
sh(`git init -q -b main ${ORIGIN} --bare && cd ${WORK} && git init -q -b main && git add -A && git commit -qm v1 && git remote add origin ${ORIGIN} && git push -q origin main`);
const head = (dir) => sh(`git -C ${dir} rev-parse HEAD`).stdout.trim();
const v1 = head(WORK);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS  " + name); } else { fail++; console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};
const SRC = path.join(RV, "src");
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);

// piped install from a directory that is not a checkout
let r = sh(`cat ${REPO}/install.sh | bash`, { env: { REVOICE_REPO: ORIGIN } });
eq("pipe: exit 0, cloned into ~/.revoice/src, installer ran from there", [r.status, fs.existsSync(path.join(SRC, ".git")), head(SRC) === v1, /==> Cloning revoice into .*\/\.revoice\/src/.test(r.stdout), /^Done\./m.test(r.stdout)], [0, true, true, true, true]);
eq("pipe: CLI installed + src-path records the clone", [fs.existsSync(path.join(RV, "bin", "revoice.js")), read(path.join(RV, "src-path"))], [true, SRC + "\n"]);
eq("pipe: hammerspoon wired", (read(path.join(HOME, ".hammerspoon", "init.lua")) || "").includes('require("revoice")'), true);
// second piped run pulls the existing clone instead of recloning
fs.writeFileSync(path.join(WORK, "PIPE2.txt"), "pipe2\n");
sh(`cd ${WORK} && git add -A && git commit -qm pipe2 && git push -q origin main`);
const vPipe2 = head(WORK);
r = sh(`cat ${REPO}/install.sh | bash`, { env: { REVOICE_REPO: ORIGIN } });
eq("pipe again: pulls the existing clone to upstream HEAD (no clone), exit 0", [r.status, /==> Updating .*\/src/.test(r.stdout), /Cloning/.test(r.stdout), head(SRC)], [0, true, false, vPipe2]);

// --update: publish v2 upstream, then update
fs.writeFileSync(path.join(WORK, "NEW.txt"), "v2\n");
sh(`cd ${WORK} && git add -A && git commit -qm v2 && git push -q origin main`);
const v2 = head(WORK);
const CLI = path.join(RV, "bin", "revoice.js");
r = sh(`node ${CLI} --update`);
eq("--update: pulls v2 into src-path checkout and re-runs install.sh (exit 0)", [r.status, head(SRC), fs.existsSync(path.join(SRC, "NEW.txt")), /==> Updating/.test(r.stderr), /==> Installing CLI/.test(r.stdout), /^Done\./m.test(r.stdout)], [0, v2, true, true, true, true]);
eq("--update: no-op when already current still exits 0", sh(`node ${CLI} --update`).status, 0);

// --update failure paths
fs.writeFileSync(path.join(SRC, "LOCAL.txt"), "local\n");
sh(`cd ${SRC} && git add -A && git commit -qm local`);
fs.writeFileSync(path.join(WORK, "NEW.txt"), "v3\n");
sh(`cd ${WORK} && git add -A && git commit -qm v3 && git push -q origin main`);
r = sh(`node ${CLI} --update`);
eq("--update: diverged checkout -> git pull --ff-only fails, install.sh NOT re-run, exit != 0", [r.status !== 0, /==> Installing CLI/.test(r.stdout), fs.existsSync(path.join(SRC, "NEW.txt")) && fs.readFileSync(path.join(SRC, "NEW.txt"), "utf8")], [true, false, "v2\n"]);
const NOGIT = path.join(T, "nogit");
fs.mkdirSync(NOGIT); fs.writeFileSync(path.join(NOGIT, "install.sh"), "echo should-not-run\n");
fs.writeFileSync(path.join(RV, "src-path"), NOGIT + "\n");
r = sh(`node ${CLI} --update`);
eq("--update: src-path without .git -> exit 1 + hint, install.sh not run", [r.status, /not a git checkout/.test(r.stderr), r.stdout], [1, true, ""]);
fs.writeFileSync(path.join(RV, "src-path"), path.join(T, "gone") + "\n");
r = sh(`node ${CLI} --update`);
eq("--update: stale src-path -> exit 1 + curl hint", [r.status, /don't know where the source is/.test(r.stderr), /curl -fsSL/.test(r.stderr)], [1, true, true]);
fs.rmSync(path.join(RV, "src-path"));
r = sh(`node ${CLI} --update`);
eq("--update: missing src-path -> exit 1", [r.status, /src-path missing or stale/.test(r.stderr)], [1, true]);

// checkout install records the checkout dir (not ~/.revoice/src)
r = sh(`bash ${WORK}/install.sh`);
eq("checkout install: exit 0, src-path = that checkout", [r.status, read(path.join(RV, "src-path"))], [0, WORK + "\n"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
