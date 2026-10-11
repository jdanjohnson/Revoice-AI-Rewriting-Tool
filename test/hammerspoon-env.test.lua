-- Contract: every hs.task the module launches (rewrite hotkeys, --mark-last)
-- gets setEnvironment({PATH=<login shell PATH + homebrew/local/.local/bin>,
-- HOME=...}) BEFORE start(). hs.execute is called with the login-shell flag,
-- the PATH is resolved once and cached, and an empty shell PATH falls back to
-- the process PATH. Run: `npm test`
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
local function eq(name, a, b)
  local sa, sb = tostring(a), tostring(b)
  if sa == sb then pass = pass + 1; print("PASS  " .. name)
  else fail = fail + 1; print("FAIL  " .. name .. "\n      got  " .. sa .. "\n      want " .. sb) end
end

local S = { hotkeys = {}, tasks = {}, execCalls = {}, shellPath = "/Users/j/.nvm/versions/node/v22/bin:/usr/bin:/bin\n" }
local wv = setmetatable({}, { __index = function() return function(self) return self end end })
hs = {
  fs = { attributes = function(p) if p == "/usr/bin/node" then return { mode = "file" } end return nil end,
    mkdir = function() end, dir = function() return function() return nil end end },
  execute = function(cmd, login)
    S.execCalls[#S.execCalls + 1] = { cmd = cmd, login = login }
    if cmd:find("PATH") then return S.shellPath end
    return "/usr/bin/node"
  end,
  application = { frontmostApplication = function() return { bundleID = function() return "x" end } end },
  json = { read = function() return nil end, encode = function(s) return '"' .. tostring(s) .. '"' end },
  window = { frontmostWindow = function() return { focus = function(self) return self end } end },
  screen = { mainScreen = function() return { frame = function() return { x = 0, y = 0, w = 1440, h = 900 } end } end },
  webview = { new = function() return wv end },
  canvas = { windowLevels = { overlay = 1 }, new = function() return { minimumTextSize = function() return { h = 40 } end, delete = function() end } end },
  styledtext = { new = function() return {} end },
  timer = { doEvery = function() return { stop = function() end } end, doAfter = function(_, fn) S.deferred = S.deferred or {}; S.deferred[#S.deferred + 1] = fn; return { stop = function() end } end,
    usleep = function() end, secondsSinceEpoch = function() return os.time() end },
  pasteboard = { getContents = function() return S.clipboard end, setContents = function(c) S.clipboard = c end,
    clearContents = function() S.clipboard = nil end, changeCount = function() return 1 end },
  eventtap = { keyStroke = function(_, key) if key == "c" then S.clipboard = "some selected text" end end,
    new = function() return { start = function() end, stop = function() end } end, event = { types = { keyDown = 10 } } },
  keycodes = { map = setmetatable({}, { __index = function(_, k) return k end }) },
  hotkey = { bind = function(_, key, fn) S.hotkeys[key] = fn end,
    modal = { new = function() local m = { keys = {} }; S.modal = m
      m.bind = function(_, _, key, fn) m.keys[key] = fn end; m.enter = function() end; m.exit = function() end; return m end } },
  dialog = { textPrompt = function() return "Draft reply", "" end },
  alert = { show = function() end },
  task = { new = function(bin, done, stream, args)
    if type(stream) == "table" then args, stream = stream, nil end -- hs.task.new(bin, cb, args) form
    local t = { bin = bin, args = args, done = done, stream = stream, order = {} }
    t.setInput = function(_, s) t.input = s end
    t.setEnvironment = function(_, env) t.env = env; t.order[#t.order + 1] = "env" end
    t.start = function() t.order[#t.order + 1] = "start"; return true end
    t.closeInput = function() end
    S.tasks[#S.tasks + 1] = t; return t end },
  menubar = { new = function() return setmetatable({}, { __index = function() return function(self) return self end end }) end },
  image = {},
}
dofile(MODULE)

-- 1. ⌃⇧Z rewrite task gets login PATH (+ fallbacks appended), HOME, env set before start
S.clipboard = "OLD"
S.hotkeys["z"]()
eq("Z: one task launched", #S.tasks, 1)
local t = S.tasks[1]
eq("Z: task env present", t.env ~= nil, true)
eq("Z: PATH = login shell PATH + homebrew/local/.local/bin", t.env and t.env.PATH,
  "/Users/j/.nvm/versions/node/v22/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:" .. HOME .. "/.local/bin")
eq("Z: HOME passed through", t.env and t.env.HOME, HOME)
eq("Z: setEnvironment before start", table.concat(t.order, ","), "env,start")
local pathCalls = 0
for _, c in ipairs(S.execCalls) do if c.cmd:find("PATH") then pathCalls = pathCalls + 1; eq("Z: PATH resolved via login shell (with_user_env=true)", c.login, true) end end
eq("Z: PATH resolved exactly once", pathCalls, 1)

-- 2. second hotkey reuses cached PATH (no new hs.execute for PATH)
S.tasks = {}
S.hotkeys["1"]()
eq("1: task launched", #S.tasks, 1)
eq("1: same PATH reused", S.tasks[1].env.PATH, t.env.PATH)
pathCalls = 0
for _, c in ipairs(S.execCalls) do if c.cmd:find("PATH") then pathCalls = pathCalls + 1 end end
eq("1: PATH still resolved only once (cached)", pathCalls, 1)

-- 3. --mark-last task (rejection learning) also gets the env
S.tasks = {}
S.deferred = {}
t.done(0, "rewritten text", "via:codex\n") -- completes → preview shown after doAfter
for _, fn in ipairs(S.deferred) do fn() end
S.modal.keys["escape"]()                    -- reject → markLast("rejected")
local marked = nil
for _, task in ipairs(S.tasks) do if task.args[2] == "--mark-last" then marked = task end end
eq("mark-last: task launched on reject", marked ~= nil, true)
eq("mark-last: argv", marked and table.concat(marked.args, " "), HOME .. "/.revoice/bin/revoice.js --mark-last rejected")
eq("mark-last: env PATH set", marked and marked.env and marked.env.PATH, t.env.PATH)
eq("mark-last: setEnvironment before start", marked and table.concat(marked.order, ","), "env,start")

-- 4. empty login PATH → falls back to process PATH (plus fallbacks) instead of empty
-- (fresh module load with a stub returning "")
S.shellPath = "\n"; S.tasks = {}; S.execCalls = {}
local procPath = os.getenv("PATH")
dofile(MODULE)
S.hotkeys["z"]()
local p = S.tasks[1].env.PATH
eq("fallback: PATH starts with process PATH when login shell returns empty", p:sub(1, #procPath), procPath)
eq("fallback: never an empty PATH", p ~= "" and p ~= nil, true)

-- 5. login PATH already containing fallback dirs is not duplicated
S.shellPath = "/opt/homebrew/bin:/usr/local/bin:" .. HOME .. "/.local/bin:/usr/bin\n"; S.tasks = {}
dofile(MODULE)
S.hotkeys["z"]()
eq("dedupe: fallback dirs not appended twice", S.tasks[1].env.PATH, "/opt/homebrew/bin:/usr/local/bin:" .. HOME .. "/.local/bin:/usr/bin")

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
