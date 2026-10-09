-- Contract: the ✍️ menu has a "Backend: <current>" submenu that reads
-- REWRITE_BACKEND from ~/.revoice/env with the CLI's rules (last assignment
-- wins, `export` prefix, quotes and trailing comments stripped) and, on click,
-- rewrites the file keeping every other line, dropping ALL old REWRITE_BACKEND
-- lines and appending exactly one (Auto = none). "Run doctor" launches
-- `revoice.js --doctor` with the login-shell env and shows stdout+stderr in a
-- blocking dialog. Run: `npm test`
local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local MODULE = HERE .. "/../hammerspoon/revoice.lua"
if not (os.getenv("HOME") or ""):match("/%.tmp%-hs%-[^/]+$") then
  io.stderr:write("refusing to run: HOME must be a scratch dir named .tmp-hs-* (use `npm test`)\n")
  os.exit(2)
end
local HOME = os.getenv("HOME")
local ENV = HOME .. "/.revoice/env"

local pass, fail = 0, 0
local function eq(name, a, b)
  local sa, sb = tostring(a), tostring(b)
  if sa == sb then pass = pass + 1; print("PASS  " .. name)
  else fail = fail + 1; print("FAIL  " .. name .. "\n      got  " .. sa .. "\n      want " .. sb) end
end
local function writeEnv(s) local f = assert(io.open(ENV, "w")); f:write(s); f:close() end
local function readEnv() local f = io.open(ENV, "r"); if not f then return nil end; local s = f:read("a"); f:close(); return s end

local S = { tasks = {}, alerts = {}, dialogs = {}, shellPath = "/Users/j/.nvm/versions/node/v22/bin:/usr/bin:/bin\n" }
local wv = setmetatable({}, { __index = function() return function(self) return self end end })
hs = {
  fs = { attributes = function(p) if p == "/usr/bin/node" then return { mode = "file" } end return nil end,
    mkdir = function() end, dir = function() return function() return nil end end },
  execute = function(cmd) if cmd:find("PATH") then return S.shellPath end return "/usr/bin/node" end,
  application = { frontmostApplication = function() return { bundleID = function() return "x" end } end },
  json = { read = function() return nil end, encode = function(s) return '"' .. tostring(s) .. '"' end,
    decode = function() return nil end },
  window = { frontmostWindow = function() return { focus = function(self) return self end } end },
  screen = { mainScreen = function() return { frame = function() return { x = 0, y = 0, w = 1440, h = 900 } end } end },
  webview = { new = function() return wv end },
  canvas = { windowLevels = { overlay = 1 }, new = function() return { minimumTextSize = function() return { h = 40 } end, delete = function() end } end },
  styledtext = { new = function() return {} end },
  timer = { doEvery = function() return { stop = function() end } end, doAfter = function(_, fn) return { stop = function() end } end,
    usleep = function() end, secondsSinceEpoch = function() return os.time() end },
  pasteboard = { getContents = function() return nil end, setContents = function() end, clearContents = function() end, changeCount = function() return 1 end },
  eventtap = { keyStroke = function() end, new = function() return { start = function() end, stop = function() end } end, event = { types = { keyDown = 10 } } },
  keycodes = { map = setmetatable({}, { __index = function(_, k) return k end }) },
  hotkey = { bind = function() end, modal = { new = function() return { bind = function() end, enter = function() end, exit = function() end } end } },
  dialog = { textPrompt = function() return "", "" end,
    blockAlert = function(title, text, btn) S.dialogs[#S.dialogs + 1] = { title = title, text = text, btn = btn } end },
  alert = { show = function(msg) S.alerts[#S.alerts + 1] = msg end },
  task = { new = function(bin, done, args)
    local t = { bin = bin, args = args, done = done, order = {} }
    t.setInput = function(_, s) t.input = s end
    t.setEnvironment = function(_, env) t.env = env; t.order[#t.order + 1] = "env" end
    t.start = function() t.order[#t.order + 1] = "start"; return true end
    t.closeInput = function() end
    S.tasks[#S.tasks + 1] = t; return t end },
  menubar = { new = function()
    local m = {}
    m.setMenu = function(_, fn) S.menuFn = fn end
    m.setTitle = function() end
    m.setTooltip = function() end
    return m end },
  image = {},
}
dofile(MODULE)

local function menu() return S.menuFn() end
local function item(items, prefix)
  for _, it in ipairs(items) do if it.title:sub(1, #prefix) == prefix then return it end end
  return nil
end
local function checked(sub)
  local out = {}
  for _, it in ipairs(sub) do if it.checked then out[#out + 1] = it.title end end
  return table.concat(out, "|")
end
local function clickOption(sub, prefix) item(sub, prefix).fn() end

-- 1. fresh install (no env file): Auto checked, picker lists every backend, doctor item present
os.remove(ENV)
local items = menu()
local picker = item(items, "Backend:")
eq("fresh: title shows auto", picker and picker.title, "Backend: auto")
eq("fresh: Auto is the only checked option", checked(picker.menu), "Auto (claude → codex → openai → kimi → ollama)")
local labels = {}
for _, it in ipairs(picker.menu) do labels[#labels + 1] = it.title:match("^(%S+)") end
eq("fresh: options in chain order", table.concat(labels, ","), "Auto,Claude,Codex,OpenAI,Kimi,Ollama")
eq("fresh: Run doctor item present with fn", item(items, "Run doctor") ~= nil and type(item(items, "Run doctor").fn), "function")

-- 2. pick Kimi: env file created with exactly one line, alert, menu rebuilt with Kimi checked
clickOption(picker.menu, "Kimi")
eq("pick kimi: env file content", readEnv(), "REWRITE_BACKEND=kimi\n")
eq("pick kimi: alert", S.alerts[#S.alerts], "backend: kimi")
items = menu(); picker = item(items, "Backend:")
eq("pick kimi: title", picker.title, "Backend: kimi")
eq("pick kimi: only Kimi checked", checked(picker.menu), "Kimi")

-- 3. existing file with other keys, comments, an `export` line and a quoted+commented line:
--    other lines kept verbatim and in order, every old REWRITE_BACKEND line removed, one appended
writeEnv("# my settings\nKIMI_API_KEY=abc\nexport REWRITE_BACKEND=claude\nOPENAI_API_KEY=sk-1 # paid\nREWRITE_BACKEND=\"openai\" # fast\n\n")
items = menu(); picker = item(items, "Backend:")
eq("quoted+comment: current parsed as openai (last wins)", picker.title, "Backend: openai")
eq("quoted+comment: OpenAI checked", checked(picker.menu), "OpenAI API (paid per token, fast)")
clickOption(picker.menu, "Codex")
eq("pick codex: others kept, old lines dropped, one appended", readEnv(),
  "# my settings\nKIMI_API_KEY=abc\nOPENAI_API_KEY=sk-1 # paid\nREWRITE_BACKEND=codex\n")
eq("pick codex: title", menu()[#items - #items + 1] and item(menu(), "Backend:").title, "Backend: codex")

-- 4. pick Auto: line removed, everything else untouched; nothing else written
clickOption(item(menu(), "Backend:").menu, "Auto")
eq("pick auto: REWRITE_BACKEND line gone, others intact", readEnv(), "# my settings\nKIMI_API_KEY=abc\nOPENAI_API_KEY=sk-1 # paid\n")
eq("pick auto: alert", S.alerts[#S.alerts], "backend: auto")
eq("pick auto: Auto checked again", checked(item(menu(), "Backend:").menu), "Auto (claude → codex → openai → kimi → ollama)")

-- 5. a hand-written chain is shown as-is and matches no single option (nothing checked)
writeEnv("REWRITE_BACKEND='codex,claude,ollama'\n")
picker = item(menu(), "Backend:")
eq("chain: title shows the chain", picker.title, "Backend: codex,claude,ollama")
eq("chain: nothing checked", checked(picker.menu), "")

-- 6. unrelated line mentioning the key is not mistaken for an assignment
writeEnv("# REWRITE_BACKEND=kimi (old note)\nMY_REWRITE_BACKEND=x\nREWRITE_BACKEND = ollama \n")
eq("spacing: `REWRITE_BACKEND = ollama ` parsed", item(menu(), "Backend:").title, "Backend: ollama")
clickOption(item(menu(), "Backend:").menu, "Claude")
eq("comment/other-key lines survive, spaced assignment replaced", readEnv(), "# REWRITE_BACKEND=kimi (old note)\nMY_REWRITE_BACKEND=x\nREWRITE_BACKEND=claude\n")

-- 7. Run doctor: node task with --doctor, login env set before start, output shown in a blocking dialog
S.tasks = {}; S.dialogs = {}
item(menu(), "Run doctor").fn()
eq("doctor: one task", #S.tasks, 1)
local t = S.tasks[1]
eq("doctor: node binary", t.bin, "/usr/bin/node")
eq("doctor: argv", table.concat(t.args, " "), HOME .. "/.revoice/bin/revoice.js --doctor")
eq("doctor: PATH = login shell PATH + fallbacks", t.env and t.env.PATH,
  "/Users/j/.nvm/versions/node/v22/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:" .. HOME .. "/.local/bin")
eq("doctor: setEnvironment before start", table.concat(t.order, ","), "env,start")
eq("doctor: no dialog before the task finishes", #S.dialogs, 0)
t.done(0, "backend chain: codex\ncodex: /opt/homebrew/bin/codex\n", "")
eq("doctor: dialog shows stdout", S.dialogs[1] and (S.dialogs[1].title .. "|" .. S.dialogs[1].text .. "|" .. S.dialogs[1].btn),
  "revoice doctor|backend chain: codex\ncodex: /opt/homebrew/bin/codex\n|OK")
t.done(1, "backend chain: ollama\n", "revoice: no usable backend\n")
eq("doctor: stderr appended after stdout on failure", S.dialogs[2] and S.dialogs[2].text, "backend chain: ollama\nrevoice: no usable backend\n")
t.done(1, "", "")
eq("doctor: silent exit still explained", S.dialogs[3] and S.dialogs[3].text, "doctor exited 1 with no output")

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
