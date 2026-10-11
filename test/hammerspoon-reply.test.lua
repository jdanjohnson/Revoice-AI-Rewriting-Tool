-- Loads hammerspoon/revoice.lua against a stub `hs`, then drives the ⌃⇧R
-- hotkey and asserts the CLI argv / stdin / screenshot lifecycle.
-- Run: `npm test` (the runner creates the scratch HOME)
-- Resolve hammerspoon/revoice.lua relative to this file; refuse to run against a real HOME
-- (it must be an empty scratch dir simulating a fresh install). `npm test` sets both up.
local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local MODULE = HERE .. "/../hammerspoon/revoice.lua"
if not (os.getenv("HOME") or ""):match("/%.tmp%-hs%-[^/]+$") then
  io.stderr:write("refusing to run: HOME must be a scratch dir named .tmp-hs-* (use `npm test`)\n")
  os.exit(2)
end
local HOME = os.getenv("HOME")  -- run.mjs creates it empty with .revoice/bin inside

local pass, fail = 0, 0
local function check(name, cond, detail)
  if cond then pass = pass + 1; print("PASS  " .. name)
  else fail = fail + 1; print("FAIL  " .. name .. "\n      " .. tostring(detail)) end
end
local function eq(name, a, b)
  local sa, sb = tostring(a), tostring(b)
  if type(a) == "table" then sa = table.concat(a, " | ") end
  if type(b) == "table" then sb = table.concat(b, " | ") end
  check(name, sa == sb, "got  " .. sa .. "\n      want " .. sb)
end

-- ---- stub hs ---------------------------------------------------------------
local S = { hotkeys = {}, tasks = {}, alerts = {}, clipboard = nil, dialog = nil, snapshotOk = true, focused = {} }
local function fileExists(p) local f = io.open(p, "r"); if f then f:close(); return true end return false end
local fakeWin = { focus = function(self) S.focused[#S.focused + 1] = self; return self end }
local fakeImg = {
  size = function() return { w = 3600, h = 2000 } end,
  setSize = function(self, sz) S.resized = sz; return self end,
  saveToFile = function(_, path) local f = assert(io.open(path, "w")); f:write("PNGDATA"); f:close(); S.saved = path; return true end,
}
fakeWin.snapshot = function() if S.snapshotOk then return fakeImg end return nil end
local wv = setmetatable({ html = function(self, h) S.html = h; return self end },
  { __index = function() return function(self) return self end end })
hs = {
  fs = {
    attributes = function(p) if not fileExists(p) then return nil end
      local h = io.popen("stat -c %Y '" .. p .. "'"); local m = tonumber(h:read("*a")); h:close(); return { modification = m } end,
    mkdir = function(p) os.execute("mkdir -p '" .. p .. "'") end,
    dir = function(d) local p = io.popen("ls -1 '" .. d .. "' 2>/dev/null"); local names = {}; for l in p:lines() do names[#names + 1] = l end; p:close()
      local i = 0; return function() i = i + 1; return names[i] end, nil end,
  },
  execute = function() return "/usr/bin/node" end,
  application = { frontmostApplication = function() return { bundleID = function() return "com.tinyspeck.slackmacgap" end } end },
  json = { read = function() return nil end, encode = function(s) return '"' .. tostring(s) .. '"' end },
  window = { frontmostWindow = function() return fakeWin end },
  screen = { mainScreen = function() return { frame = function() return { x = 0, y = 0, w = 1440, h = 900 } end } end },
  webview = { new = function(frame) S.frame = frame; return wv end },
  canvas = { windowLevels = { overlay = 1 }, new = function() return { minimumTextSize = function() return { h = 40 } end, delete = function() end } end },
  styledtext = { new = function() return {} end },
  timer = {
    doEvery = function() return { stop = function() end } end,
    doAfter = function(_, fn) S.deferred = S.deferred or {}; S.deferred[#S.deferred + 1] = fn; return { stop = function() end } end,
    usleep = function() end,
    secondsSinceEpoch = function() return os.time() end,
  },
  pasteboard = {
    getContents = function() return S.clipboard end,
    setContents = function(c) S.clipboard = c end,
    clearContents = function() S.clipboard = nil end,
    changeCount = function() return 1 end,
  },
  eventtap = { keyStroke = function(mods, key) if key == "c" then S.clipboard = S.selection end end, new = function() return { start = function() end, stop = function() end } end, event = { types = { keyDown = 10 } } },
  keycodes = { map = setmetatable({}, { __index = function(_, k) return k end }) },
  hotkey = { bind = function(mods, key, fn) S.hotkeys[key] = fn end, modal = { new = function() return { bind = function() end, enter = function() end, exit = function() end } end } },
  dialog = { textPrompt = function() return S.dialog[1], S.dialog[2] end },
  alert = { show = function(m) S.alerts[#S.alerts + 1] = m end },
  task = { new = function(bin, done, stream, args) local t = { bin = bin, args = args, done = done, stream = stream }
    t.setInput = function(_, s) t.input = s end; t.setEnvironment = function(_, e) t.env = e end; t.start = function() return true end; t.closeInput = function() end
    S.tasks[#S.tasks + 1] = t; return t end },
  menubar = { new = function() return setmetatable({}, { __index = function() return function(self) return self end end }) end },
  image = {},
}
math.randomseed(1)
dofile(MODULE)
local CLI = HOME .. "/.revoice/bin/revoice.js"

local function reset() S.tasks = {}; S.alerts = {}; S.deferred = {}; S.focused = {}; S.saved = nil; S.resized = nil end

-- 1. happy path: screenshot + selection + notes
reset(); S.snapshotOk = true; S.selection = "Dylan: is the SOW done?"; S.clipboard = "OLD CLIP"; S.dialog = { "Draft reply", "yes, friday" }
S.hotkeys["r"]()
eq("R: one CLI task launched", #S.tasks, 1)
local t = S.tasks[1]
check("R: screenshot saved under ~/.revoice/tmp/reply-<ms>.png", S.saved and S.saved:sub(1, #HOME) == HOME and S.saved:sub(#HOME + 1):match("^/%.revoice/tmp/reply%-%d+%.png$"), S.saved)
eq("R: wide snapshot downscaled to 1800", S.resized and S.resized.w, 1800)
eq("R: argv = CLI --stream --log-history --style casual --reply --image <png> --context <sel>",
  t.args, { CLI, "--stream", "--log-history", "--style", "casual", "--reply", "--image", S.saved, "--context", "Dylan: is the SOW done?" })
eq("R: notes go to stdin", t.input, "yes, friday")
eq("R: target window refocused after dialog", #S.focused >= 1, true)
-- CLI completes -> preview shown, then screenshot swept (fresh file kept; stale sweep + timer)
t.done(0, "Yep — Friday works. SOW's with Sam for sign-off.", "via:codex\n")
check("R: screenshot still exists right after completion (kept for regenerate)", fileExists(S.saved), S.saved)
eq("R: a delayed sweep timer was scheduled", #S.deferred >= 2, true)
-- stale file gets swept
os.execute("touch -d '5 minutes ago' '" .. S.saved .. "'")
S.deferred[#S.deferred]()
check("R: stale screenshot removed by sweep", not fileExists(S.saved), "still exists")

-- 2. empty notes are allowed (infer)
reset(); S.selection = nil; S.clipboard = "OLD"; S.dialog = { "Draft reply", "" }
S.hotkeys["r"]()
eq("R empty notes: task launched with empty stdin", { #S.tasks, S.tasks[1].input }, { 1, "" })
eq("R empty notes: no --context when nothing selected", S.tasks[1].args[#S.tasks[1].args - 1], "--image")
eq("R empty notes: --reply present", S.tasks[1].args[6], "--reply")

-- 3. cancel: screenshot deleted, clipboard restored, no task
reset(); S.selection = "sel"; S.clipboard = "OLD"; S.dialog = { "Cancel", "" }
S.hotkeys["r"]()
eq("R cancel: no CLI task", #S.tasks, 0)
eq("R cancel: clipboard restored", S.clipboard, "OLD")
check("R cancel: screenshot deleted immediately", S.saved and not fileExists(S.saved), S.saved)

-- 4. snapshot fails (no Screen Recording permission) + no selection -> abort with hint
reset(); S.snapshotOk = false; S.selection = nil; S.clipboard = "OLD"; S.dialog = { "Draft reply", "hi" }
S.hotkeys["r"]()
eq("R no shot/no sel: no task", #S.tasks, 0)
check("R no shot/no sel: permission hint alert", S.alerts[1] and S.alerts[1]:match("Screen Recording"), S.alerts[1])
eq("R no shot/no sel: clipboard restored", S.clipboard, "OLD")

-- 5. snapshot fails but text selected -> text-only reply (no --image)
reset(); S.snapshotOk = false; S.selection = "Dylan: ok?"; S.clipboard = "OLD"; S.dialog = { "Draft reply", "yes" }
S.hotkeys["r"]()
eq("R no shot + sel: argv has --reply --context, no --image",
  S.tasks[1].args, { CLI, "--stream", "--log-history", "--style", "casual", "--reply", "--context", "Dylan: ok?" })

-- 6. plain ⌃⇧Z unchanged
reset(); S.snapshotOk = true; S.selection = "draft text"; S.clipboard = "OLD"
S.hotkeys["z"]()
eq("Z: argv unchanged (no reply flags)", S.tasks[1].args, { CLI, "--stream", "--log-history", "--style", "casual" })
eq("Z: selection on stdin", S.tasks[1].input, "draft text")

-- 7. failure path in reply mode labels the alert "Reply failed"
reset(); S.selection = nil; S.clipboard = "OLD"; S.dialog = { "Draft reply", "x" }
S.hotkeys["r"]()
S.tasks[1].done(1, "", "codex exited 1: ERROR: boom")
check("R failure: alert says Reply failed", S.alerts[#S.alerts]:match("^Reply failed: codex exited 1"), S.alerts[#S.alerts])
eq("R failure: clipboard restored", S.clipboard, "OLD")


-- flags: `flag:` lines on stderr become amber chips in the preview; none -> no chips, same height
reset(); S.selection = "send it to them by friday"; S.clipboard = "OLD"; S.dialog = { "Draft reply", "" }
S.hotkeys["z"]()
S.tasks[1].done(0, "Send it to them by Friday.", "via:codex\n")
for _, fn in ipairs(S.deferred) do fn() end
local plainH = S.frame and S.frame.h
check("flags: no flag lines -> no chips", S.html and not S.html:find('class="flag"', 1, true), S.html and S.html:sub(1, 200))
reset(); S.hotkeys["z"]()
S.tasks[1].done(0, "Send it to them by Friday.", "via:openai\nflag:who is \"them\" <legal> or the client?\nflag:this Friday or next?\n")
for _, fn in ipairs(S.deferred) do fn() end
check("flags: two chips rendered in order",
  S.html and S.html:find('<span class="flag">⚑ who is "them" &lt;legal&gt; or the client?</span><span class="flag">⚑ this Friday or next?</span>', 1, true) ~= nil,
  S.html and S.html:match('<div class="flags">.-</div>'))
check("flags: chips sit between the rewrite and the key hints", S.html and (S.html:find('class="flags"', 1, true) > S.html:find('class="body"', 1, true)) and (S.html:find('class="flags"', 1, true) < S.html:find('class="hints"', 1, true)), S.html and S.html:sub(-400))
eq("flags: card grows by one chip row (36px) for two flags", S.frame and plainH and (S.frame.h - plainH), 36)
reset(); S.hotkeys["z"]()
S.tasks[1].done(0, string.rep("long line of rewritten text that fills the card\n", 60), "via:openai\nflag:a\nflag:b\nflag:c\n")
for _, fn in ipairs(S.deferred) do fn() end
eq("flags: chip rows are added on top of the 60% screen cap (never clipped)", S.frame and S.frame.h, 150 + 72)  -- stub text height 40 -> 150 floor; 3 flags = 2 rows

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
