-- revoice Hammerspoon hotkeys
-- ⌃⇧Z : rewrite selected text (auto style by app; Claude → Codex → Kimi → Ollama, or REWRITE_BACKEND)
-- ⌃⇧E : rewrite selected text with a custom instruction (prompt box)
-- ⌃⇧1 : rewrite in Founder style (direct, decisive)
-- ⌃⇧2 : rewrite in Casual style (relaxed, friendly)
-- ⌃⇧3 : rewrite in Professional style (polished business)
-- ⌃⇧4 : rewrite in Concise style (half the words)
--
-- The rewrite streams into a glowing orb HUD, then lands in a preview:
--   ⏎ paste it · R regenerate · 1–4 re-run in a style · esc keep original
--
-- Style prompts are editable files in ~/.revoice/styles/
-- Requires the revoice CLI (see ../README.md).

local CLI = os.getenv("HOME") .. "/.revoice/bin/revoice.js"

local function findNode()
  for _, p in ipairs({ "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node" }) do
    if hs.fs.attributes(p) then return p end
  end
  local out = hs.execute("command -v node", true)
  if out then
    out = out:gsub("%s+$", "")
    if out ~= "" and hs.fs.attributes(out) then return out end
  end
  return nil
end

-- context awareness: pick a tone from the frontmost app for plain ⌃⇧Z ------
-- (override or extend in ~/.revoice/app-styles.json:
--   { "com.tinyspeck.slackmacgap": "casual", "com.apple.mail": "professional" })
local DEFAULT_APP_STYLES = {
  ["com.tinyspeck.slackmacgap"] = "casual",   -- Slack
  ["com.hnc.Discord"] = "casual",             -- Discord
  ["net.whatsapp.WhatsApp"] = "casual",       -- WhatsApp
  ["com.apple.MobileSMS"] = "casual",         -- Messages
  ["ru.keepcoder.Telegram"] = "casual",       -- Telegram
  ["com.apple.mail"] = "professional",        -- Mail
  ["com.microsoft.Outlook"] = "professional", -- Outlook
  ["com.readdle.smartemail-Mac"] = "professional", -- Spark
}

local function loadAppStyles()
  local path = os.getenv("HOME") .. "/.revoice/app-styles.json"
  if hs.fs.attributes(path) then
    local ok, custom = pcall(hs.json.read, path)
    if ok and type(custom) == "table" then
      local merged = {}
      for k, v in pairs(DEFAULT_APP_STYLES) do merged[k] = v end
      for k, v in pairs(custom) do merged[k] = v end
      return merged
    end
  end
  return DEFAULT_APP_STYLES
end

local function styleForFrontmostApp()
  local app = hs.application.frontmostApplication()
  local bundle = app and app:bundleID()
  if not bundle then return nil end
  local style = loadAppStyles()[bundle]
  if style == "" then return nil end -- explicit "use the voice guide"
  return style
end

-- ✨ liquid-glass HUD: frosted glass pill over drifting aurora blobs, with a
-- glowing orb, sparkles, and a live stream tail (hs.webview + CSS glass) ----
local ORB_MESSAGES = {
  "reading your vibe…",
  "borrowing your voice…",
  "tuning the words…",
  "making it sound like you…",
  "spinning up sentences…",
  "distilling the point…",
}

-- safely embed a Lua string as a JS string literal
local function jsStr(s)
  return hs.json.encode(s or "") or '""'
end

local function htmlEscape(s)
  return (s or ""):gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
end

-- shared liquid-glass CSS: aurora blobs behind a backdrop-blurred glass card
-- with a luminous border and a specular top highlight
local GLASS_CSS = [[
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:transparent;overflow:hidden;height:100%;
  font-family:-apple-system,BlinkMacSystemFont,sans-serif;
  -webkit-font-smoothing:antialiased}
.scene{position:fixed;inset:0;border-radius:26px;overflow:hidden}
.blobs{position:absolute;inset:-45%}
.blob{position:absolute;width:65%;height:85%;border-radius:50%;
  filter:blur(30px);opacity:.9}
.b1{background:radial-gradient(circle,#7c5cff 0%,transparent 68%);
  animation:drift1 7s ease-in-out infinite}
.b2{background:radial-gradient(circle,#2ee6ff 0%,transparent 68%);right:0;
  animation:drift2 9s ease-in-out infinite}
.b3{background:radial-gradient(circle,#ff6ad5 0%,transparent 68%);
  left:28%;top:28%;animation:drift3 11s ease-in-out infinite}
@keyframes drift1{50%{transform:translate(28%,18%) scale(1.25)}}
@keyframes drift2{50%{transform:translate(-24%,14%) scale(.85)}}
@keyframes drift3{50%{transform:translate(14%,-18%) scale(1.2)}}
.glass{position:absolute;inset:0;border-radius:26px;
  background:linear-gradient(135deg,rgba(255,255,255,.18),rgba(255,255,255,.05));
  -webkit-backdrop-filter:blur(24px) saturate(1.8);
  backdrop-filter:blur(24px) saturate(1.8);
  border:1px solid rgba(255,255,255,.38);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),
    inset 0 -1px 0 rgba(255,255,255,.08),
    0 8px 32px rgba(20,10,60,.35)}
.glass::before{content:"";position:absolute;top:1px;left:8%;right:38%;
  height:46%;border-radius:26px 26px 60% 60%;pointer-events:none;
  background:linear-gradient(rgba(255,255,255,.3),transparent)}
]]

local function hudHTML(message)
  return [[<!DOCTYPE html><html><head><meta charset="utf-8"><style>
]] .. GLASS_CSS .. [[
.glass{display:flex;align-items:center;gap:16px;padding:0 20px}
.orbwrap{position:relative;flex:none;width:40px;height:40px}
.orb{position:absolute;inset:3px;border-radius:50%;
  background:radial-gradient(circle at 32% 28%,#fff 0%,#cdb6ff 30%,#8a63ff 62%,#4b2fd6 100%);
  box-shadow:0 0 18px 5px rgba(150,110,255,.8),
    inset 0 0 8px rgba(255,255,255,.65);
  animation:breathe 1.7s ease-in-out infinite}
@keyframes breathe{50%{transform:scale(1.16);
  box-shadow:0 0 28px 9px rgba(150,110,255,.95),
    inset 0 0 10px rgba(255,255,255,.8)}}
.orb.done{background:radial-gradient(circle at 32% 28%,#fff 0%,#a6f5c8 30%,#3fd98a 62%,#14a35c 100%);
  box-shadow:0 0 26px 9px rgba(80,230,150,.85),inset 0 0 10px rgba(255,255,255,.8);
  animation:pop .4s ease-out forwards}
@keyframes pop{0%{transform:scale(.9)}55%{transform:scale(1.45)}100%{transform:scale(1.1)}}
.sp{position:absolute;color:#fff;font-size:10px;
  text-shadow:0 0 6px rgba(200,170,255,.9);opacity:0;
  animation:twinkle 2.4s linear infinite}
.sp1{top:-6px;left:16px;animation-delay:0s}
.sp2{top:14px;left:-8px;animation-delay:.8s}
.sp3{top:28px;left:38px;animation-delay:1.6s}
@keyframes twinkle{0%,100%{opacity:0;transform:scale(.4) rotate(0deg)}
  50%{opacity:.95;transform:scale(1.1) rotate(180deg)}}
.txt{min-width:0;flex:1}
#status{color:#fff;font-size:15px;font-weight:600;
  text-shadow:0 1px 8px rgba(30,10,80,.5);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
#stream{color:rgba(255,255,255,.78);font-size:12px;margin-top:3px;
  white-space:nowrap;overflow:hidden;text-shadow:0 1px 4px rgba(30,10,80,.4)}
</style></head><body><div class="scene">
<div class="blobs"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>
<div class="glass">
  <div class="orbwrap"><div class="orb" id="orb"></div>
    <span class="sp sp1">✦</span><span class="sp sp2">✧</span><span class="sp sp3">⋆</span>
  </div>
  <div class="txt"><div id="status">]] .. htmlEscape(message) .. [[</div><div id="stream"></div></div>
</div></div>
<script>
function setStatus(t){document.getElementById('status').textContent=t}
function setStream(t){document.getElementById('stream').textContent=t}
function pop(){document.getElementById('orb').className='orb done';setStatus('ready ✓')}
</script></body></html>]]
end

local hud = { wv = nil, timer = nil, watchdog = nil, streamText = "", styleLabel = nil }

local function hudStop()
  if hud.watchdog then hud.watchdog:stop(); hud.watchdog = nil end
  if hud.timer then hud.timer:stop(); hud.timer = nil end
  if hud.wv then hud.wv:delete(false, 0.15); hud.wv = nil end
  hud.streamText = ""
end

local W = 480

local function hudStart(styleLabel)
  hudStop()
  hud.styleLabel = styleLabel
  local screen = hs.screen.mainScreen():frame()
  local h = 68
  local msg = ORB_MESSAGES[math.random(#ORB_MESSAGES)]
  if styleLabel then msg = styleLabel .. " · " .. msg end
  hud.wv = hs.webview.new({
    x = screen.x + (screen.w - W) / 2,
    y = screen.y + screen.h * 0.12,
    w = W, h = h,
  })
  hud.wv:windowStyle({ "borderless" })
  hud.wv:transparent(true)
  hud.wv:allowTextEntry(false)
  hud.wv:level(hs.canvas.windowLevels.overlay)
  hud.wv:html(hudHTML(msg))
  hud.wv:show(0.15)

  -- rotate the playful status line while we wait
  hud.timer = hs.timer.doEvery(4, function()
    if not hud.wv then return end
    local m = ORB_MESSAGES[math.random(#ORB_MESSAGES)]
    if hud.styleLabel then m = hud.styleLabel .. " · " .. m end
    hud.wv:evaluateJavaScript("setStatus(" .. jsStr(m) .. ")")
  end)
  hud.watchdog = hs.timer.doAfter(90, hudStop)
end

-- live tail of the streaming rewrite under the status line
local function hudStream(chunk)
  if not hud.wv then return end
  hud.streamText = hud.streamText .. chunk
  local tail = hud.streamText:gsub("%s+", " ")
  if #tail > 62 then
    local cut = tail:sub(-61)
    -- never start mid-UTF-8-character: drop leading continuation bytes
    cut = cut:gsub("^[\128-\191]+", "")
    tail = "…" .. cut
  end
  hud.wv:evaluateJavaScript("setStream(" .. jsStr(tail) .. ")")
end

-- satisfying "pop" when the rewrite lands
local function hudPop()
  if not hud.wv then return end
  if hud.timer then hud.timer:stop(); hud.timer = nil end
  hud.wv:evaluateJavaScript("pop()")
  hs.timer.doAfter(0.45, hudStop)
end
------------------------------------------------------------------------------

local function restoreClipboard(oldClipboard)
  if oldClipboard then
    hs.pasteboard.setContents(oldClipboard)
  else
    hs.pasteboard.clearContents()
  end
end

local function getSelection()
  local old = hs.pasteboard.getContents()
  hs.pasteboard.clearContents()
  hs.eventtap.keyStroke({ "cmd" }, "c")
  hs.timer.usleep(250000)
  local sel = hs.pasteboard.getContents()
  return sel, old
end

-- record the history outcome for the learning loop; andThen (optional) runs
-- after the mark is persisted so a follow-up rewrite sees it in its prompt
local function markLast(outcome, andThen)
  local node = findNode()
  if not node then
    if andThen then andThen() end
    return
  end
  local task = hs.task.new(node, function()
    if andThen then andThen() end
  end, { CLI, "--mark-last", outcome })
  if task and task:start() then return end
  if andThen then andThen() end
end

-- rewrite preview popover: a liquid-glass card ---------------------------------
local function previewHTML(result, title)
  return [[<!DOCTYPE html><html><head><meta charset="utf-8"><style>
]] .. GLASS_CSS .. [[
.glass{display:flex;flex-direction:column;padding:16px 20px 12px}
.title{color:#b8ffd9;font-size:13px;font-weight:700;flex:none;
  text-shadow:0 0 10px rgba(80,230,150,.55);margin-bottom:8px}
.body{color:rgba(255,255,255,.96);font-size:14px;line-height:1.45;
  flex:1;min-height:0;overflow:hidden;white-space:pre-wrap;
  word-wrap:break-word;text-shadow:0 1px 4px rgba(30,10,80,.35)}
.hints{flex:none;display:flex;gap:8px;margin-top:10px}
.chip{color:rgba(255,255,255,.85);font-size:11px;padding:3px 10px;
  border-radius:999px;background:rgba(255,255,255,.12);
  border:1px solid rgba(255,255,255,.22)}
</style></head><body><div class="scene">
<div class="blobs"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>
<div class="glass">
  <div class="title">✨ ]] .. htmlEscape(title) .. [[</div>
  <div class="body">]] .. htmlEscape(result) .. [[</div>
  <div class="hints">
    <span class="chip">⏎ paste</span><span class="chip">R regenerate</span>
    <span class="chip">1–4 restyle</span><span class="chip">esc keep original</span>
  </div>
</div></div></body></html>]]
end

local preview = { wv = nil, modal = nil, watchdog = nil, tap = nil }

local function previewClose()
  if preview.watchdog then preview.watchdog:stop(); preview.watchdog = nil end
  if preview.tap then preview.tap:stop(); preview.tap = nil end
  if preview.modal then preview.modal:exit(); preview.modal = nil end
  if preview.wv then preview.wv:delete(false, 0.15); preview.wv = nil end
end

local menubarRefresh -- forward decl (defined with the menu bar below)

local doRewrite -- forward decl

local function previewShow(result, ctx)
  previewClose()
  local screen = hs.screen.mainScreen():frame()
  local w = math.min(560, screen.w - 80)
  -- estimate the card height from the text (still measure with hs.canvas)
  local styled = hs.styledtext.new(result, {
    font = { name = ".AppleSystemUIFont", size = 14 },
    color = { white = 1, alpha = 0.95 },
  })
  local measure = hs.canvas.new({ x = 0, y = 0, w = w - 40, h = 10 })
  local textH = measure:minimumTextSize(styled).h
  measure:delete()
  local h = math.min(math.max(textH * 1.1 + 96, 150), screen.h * 0.6)
  local title = "rewrite ready"
  if ctx.style and ctx.style ~= "" then title = title .. " · " .. ctx.style end
  if ctx.via then title = title .. " · " .. ctx.via end
  preview.wv = hs.webview.new({
    x = screen.x + (screen.w - w) / 2,
    y = screen.y + screen.h * 0.12,
    w = w, h = h,
  })
  preview.wv:windowStyle({ "borderless" })
  preview.wv:transparent(true)
  preview.wv:allowTextEntry(false)
  preview.wv:level(hs.canvas.windowLevels.overlay)
  preview.wv:html(previewHTML(result, title))
  preview.wv:show(0.15)

  preview.modal = hs.hotkey.modal.new()
  preview.modal:bind({}, "return", function()
    previewClose()
    if ctx.targetWindow and ctx.targetWindow ~= hs.window.frontmostWindow() then
      ctx.targetWindow:focus()
      hs.timer.usleep(300000)
    end
    hs.pasteboard.setContents(result)
    local pasteCount = hs.pasteboard.changeCount()
    hs.eventtap.keyStroke({ "cmd" }, "v")
    hs.timer.doAfter(2, function()
      if hs.pasteboard.changeCount() == pasteCount then
        restoreClipboard(ctx.oldClipboard)
      end
    end)
    markLast("accepted")
    if menubarRefresh then menubarRefresh() end
  end)
  preview.modal:bind({}, "escape", function()
    previewClose()
    restoreClipboard(ctx.oldClipboard)
    markLast("rejected")
    hs.alert.show("kept your original", 1)
  end)
  preview.modal:bind({}, "r", function()
    previewClose()
    markLast("rejected", function()
      doRewrite(ctx.sel, ctx.oldClipboard, ctx.instruction, ctx.style, ctx.targetWindow)
    end)
  end)
  local STYLE_KEYS = { "founder", "casual", "professional", "concise" }
  for i, style in ipairs(STYLE_KEYS) do
    preview.modal:bind({}, tostring(i), function()
      previewClose()
      markLast("rejected", function()
        doRewrite(ctx.sel, ctx.oldClipboard, ctx.instruction, style, ctx.targetWindow)
      end)
    end)
  end
  preview.modal:enter()

  -- the modal binds plain keys system-wide, so bail out the moment the user
  -- types anything else: close the preview and give them their keys back
  local HANDLED = {}
  for _, k in ipairs({ "return", "escape", "r", "1", "2", "3", "4" }) do
    HANDLED[hs.keycodes.map[k]] = true
  end
  preview.tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(ev)
    local f = ev:getFlags()
    local hasMod = f.cmd or f.ctrl or f.alt or f.shift or f.fn
    if not HANDLED[ev:getKeyCode()] or hasMod then
      previewClose()
      restoreClipboard(ctx.oldClipboard)
    end
    return false
  end)
  preview.tap:start()

  -- never leave the popover (and its key bindings) up forever
  preview.watchdog = hs.timer.doAfter(45, function()
    previewClose()
    restoreClipboard(ctx.oldClipboard)
  end)
end

doRewrite = function(sel, oldClipboard, instruction, style, targetWindow)
  local node = findNode()
  if not node then
    restoreClipboard(oldClipboard)
    hs.alert.show("revoice: node not found — brew install node", 4)
    return
  end

  targetWindow = targetWindow or hs.window.frontmostWindow()
  hudStart(style)

  local args = { CLI, "--stream", "--log-history" }
  if instruction and instruction ~= "" then
    table.insert(args, "--instruction")
    table.insert(args, instruction)
  end
  if style and style ~= "" then
    table.insert(args, "--style")
    table.insert(args, style)
  end

  local collected, collectedErr = "", ""
  local task = hs.task.new(node, function(exitCode, stdOut, stdErr)
    -- guard against a final callback that re-delivers the full buffer
    if stdOut and stdOut ~= "" and stdOut ~= collected then
      collected = collected .. stdOut
    end
    collectedErr = collectedErr .. (stdErr or "")
    local result = collected:gsub("^%s+", ""):gsub("%s+$", "")
    if exitCode == 0 and result ~= "" then
      hudPop()
      local via = collectedErr:match("via:(%w+)")
      hs.timer.doAfter(0.4, function()
        previewShow(result, {
          sel = sel,
          oldClipboard = oldClipboard,
          instruction = instruction,
          style = style,
          via = via,
          targetWindow = targetWindow,
        })
      end)
      if menubarRefresh then menubarRefresh() end
    else
      hudStop()
      restoreClipboard(oldClipboard)
      local err = collectedErr
      if not err or err == "" then err = "unknown error" end
      hs.alert.show("Rewrite failed: " .. err, 4)
    end
  end, function(_, stdOut, stdErr)
    if stdOut and stdOut ~= "" then
      collected = collected .. stdOut
      hudStream(stdOut)
    end
    if stdErr and stdErr ~= "" then collectedErr = collectedErr .. stdErr end
    return true
  end, args)
  if not task then
    hudStop()
    restoreClipboard(oldClipboard)
    hs.alert.show("revoice: failed to launch CLI", 4)
    return
  end
  task:setInput(sel)
  if not task:start() then
    hudStop()
    restoreClipboard(oldClipboard)
    hs.alert.show("revoice: failed to launch CLI", 4)
    return
  end
  task:closeInput()
end

local function withSelection(fn)
  local sel, oldClipboard = getSelection()
  if not sel or sel == "" then
    hs.alert.show("revoice: no text selected")
    restoreClipboard(oldClipboard)
    return
  end
  fn(sel, oldClipboard)
end

-- ⌃⇧Z: default rewrite, tone auto-picked from the frontmost app
hs.hotkey.bind({ "ctrl", "shift" }, "z", function()
  local style = styleForFrontmostApp()
  withSelection(function(sel, old) doRewrite(sel, old, nil, style) end)
end)

-- ⌃⇧1–4: explicit style hotkeys
local STYLES = { "founder", "casual", "professional", "concise" }
for i, style in ipairs(STYLES) do
  hs.hotkey.bind({ "ctrl", "shift" }, tostring(i), function()
    withSelection(function(sel, old) doRewrite(sel, old, nil, style) end)
  end)
end

hs.hotkey.bind({ "ctrl", "shift" }, "e", function()
  withSelection(function(sel, old)
    local ok, instruction = hs.dialog.textPrompt(
      "Rewrite with instruction",
      "How should the selected text be rewritten?",
      "", "Rewrite", "Cancel"
    )
    if ok == "Rewrite" then
      doRewrite(sel, old, instruction, nil)
    else
      restoreClipboard(old)
    end
  end)
end)

-- menu bar: recent rewrites, styles, voice sync -------------------------------
local menubar = hs.menubar.new()

local function readRecentHistory()
  local path = os.getenv("HOME") .. "/.revoice/history.jsonl"
  local f = io.open(path, "r")
  if not f then return {} end
  local lines = {}
  for line in f:lines() do
    if line ~= "" then table.insert(lines, line) end
  end
  f:close()
  local entries = {}
  for i = #lines, math.max(#lines - 7, 1), -1 do
    local ok, e = pcall(hs.json.decode, lines[i])
    if ok and e and e.rewrite then table.insert(entries, e) end
  end
  return entries
end

local function buildMenu()
  local items = {}
  local recents = readRecentHistory()
  if #recents == 0 then
    table.insert(items, { title = "No rewrites yet — select text and hit ⌃⇧Z", disabled = true })
  else
    table.insert(items, { title = "Recent rewrites (click to copy)", disabled = true })
    for _, e in ipairs(recents) do
      local label = e.rewrite:gsub("%s+", " ")
      if #label > 60 then label = label:sub(1, 57) .. "…" end
      local mark = e.outcome == "accepted" and "✓ " or (e.outcome == "rejected" and "✗ " or "· ")
      table.insert(items, {
        title = mark .. label,
        fn = function()
          hs.pasteboard.setContents(e.rewrite)
          hs.alert.show("copied ✓", 1)
        end,
      })
    end
  end
  table.insert(items, { title = "-" })
  table.insert(items, {
    title = "Edit voice samples",
    fn = function() hs.execute("touch ~/.revoice/voice-samples.txt && open -e ~/.revoice/voice-samples.txt", true) end,
  })
  table.insert(items, {
    title = "Edit rewrite prompt",
    fn = function() hs.execute("open -e ~/.revoice/prompt.txt", true) end,
  })
  table.insert(items, {
    title = "Hotkeys: ⌃⇧Z rewrite · ⌃⇧E instruct · ⌃⇧1–4 styles",
    disabled = true,
  })
  return items
end

menubarRefresh = function()
  if menubar then menubar:setMenu(buildMenu) end
end

if menubar then
  menubar:setTitle("✍️")
  menubar:setTooltip("revoice")
  menubar:setMenu(buildMenu)
end
