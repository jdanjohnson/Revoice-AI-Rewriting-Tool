// Fake Ollama (4711) + fake streaming Kimi that dies mid-stream (4712) + answering Kimi (4713)
// + fake OpenAI (4714). Separate process
// so the synchronous test runner can't block them.
import { createServer } from "node:http";
import fs from "node:fs";
const T = process.argv[2];

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(`${T}/ollama.log`, body + "\n");
    let delay = 0;
    try { delay = Number(fs.readFileSync(`${T}/ollama.delay`, "utf8")); } catch {}
    setTimeout(answer, delay);
  });
  function answer() {
    const parsed = JSON.parse(body);
    const userMsg = parsed.messages.find((m) => m.role === "user");
    // canned reply: tests write ${T}/ollama.reply to control the model's answer verbatim
    let content = `OLLAMA: ${userMsg.content}`;
    try { content = fs.readFileSync(`${T}/ollama.reply`, "utf8"); } catch {}
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: { role: "assistant", content } }));
  }
}).listen(4711);

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(`${T}/kimi.log`, body + "\n");
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"content":"PARTIAL-"}}]}\n\n');
    setTimeout(() => res.destroy(), 50);
  });
}).listen(4712, () => console.log("ready"));

// fake Kimi that answers (non-stream + stream), logs body, port 4713
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(`${T}/kimi-ok.log`, body + "\n");
    const parsed = JSON.parse(body);
    const u = parsed.messages.find((m) => m.role === "user");
    const text = typeof u.content === "string" ? u.content : u.content.find((p) => p.type === "text").text;
    if (parsed.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "KIMI: " + text.slice(0, 40) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "KIMI: " + text.slice(0, 40) } }] }));
    }
  });
}).listen(4713);

// fake OpenAI (4714): logs headers+body, answers non-stream + SSE stream. Tests control it via
// ${T}/openai.reply (verbatim content) and ${T}/openai.status (HTTP status to fail with).
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(`${T}/openai.log`, JSON.stringify({ path: req.url, auth: req.headers.authorization || null, body: JSON.parse(body) }) + "\n");
    let delay = 0;
    try { delay = Number(fs.readFileSync(`${T}/openai.delay`, "utf8")); } catch {}
    let answered = false;
    req.on("close", () => { if (!answered) fs.appendFileSync(`${T}/openai-aborted.log`, "client aborted before response\n"); });
    setTimeout(() => { answered = true; answer(); }, delay);
  });
  function answer() {
    let status = 0;
    try { status = Number(fs.readFileSync(`${T}/openai.status`, "utf8")); } catch {}
    if (status) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: { message: `fake failure ${status}`, type: "invalid_request_error" } }));
    }
    const parsed = JSON.parse(body);
    const u = parsed.messages.find((m) => m.role === "user");
    const text = typeof u.content === "string" ? u.content : u.content.find((p) => p.type === "text").text;
    let content = "OPENAI: " + text.slice(0, 40);
    try { content = fs.readFileSync(`${T}/openai.reply`, "utf8"); } catch {}
    if (parsed.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const half = Math.ceil(content.length / 2);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, half) } }] })}\n\n`);
      // ${T}/openai.truncate: orderly close after the first delta, no [DONE]
      if (fs.existsSync(`${T}/openai.truncate`)) return res.end();
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(half) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    }
  }
}).listen(4714);

// Fake Zo MCP (4715). Every request is authenticated and logged so tests can
// prove the CLI's allowlist and context-mode boundaries without live Zo calls.
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let request;
    try { request = JSON.parse(body); } catch { res.statusCode = 400; return res.end(); }
    fs.appendFileSync(`${T}/zo.log`, JSON.stringify({
      method: request.method,
      name: request.params?.name,
      arguments: request.params?.arguments,
      authorization: req.headers.authorization || null,
      session: req.headers["mcp-session-id"] || null,
    }) + "\n");
    if (req.headers.authorization !== "Bearer test-token") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (request.method === "notifications/initialized") {
      res.statusCode = 202;
      return res.end();
    }
    let payload;
    if (request.method === "initialize") {
      payload = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-zo", version: "1.0.0" },
        },
      };
      return send(payload, "fake-session");
    }
    if (request.method !== "tools/call") {
      payload = { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } };
      return send(payload);
    }
    if (req.headers["mcp-session-id"] !== "fake-session") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "missing MCP session" }));
    }
    const tool = request.params?.name;
    const args = request.params?.arguments || {};
    let text = "";
    let isError = false;
    if (tool === "read_file") {
      const file = args.target_file || "";
      if (file.endsWith("/Records/Context/you.md")) text = "YOU CARD\nTimezone: America/New_York\n";
      else if (file.endsWith("/Records/Contacts/alex-example.md")) text = "ALEX DOSSIER\nContact from example.com.\n";
      else { text = "file not found"; isError = true; }
    } else if (tool === "use_app_google_calendar" &&
      args.tool_name === "google_calendar-query-free-busy-calendars") {
      let failedAccount = "";
      try { failedAccount = fs.readFileSync(`${T}/zo.fail-account`, "utf8").trim(); } catch {}
      if (args.email === failedAccount) {
        text = "calendar unavailable";
        isError = true;
      } else {
        text = "exports={} os=[] ret={'kind': 'calendar#freeBusy', 'calendars': {'primary': {'busy': [{'start': '2026-10-26T09:00:00-04:00', 'end': '2026-10-26T10:00:00-04:00'}, {'start': '2026-10-27T14:00:00-04:00', 'end': '2026-10-27T17:00:00-04:00'}]}}} stash_id=None t={}";
      }
    } else {
      text = "unexpected fake tool";
      isError = true;
    }
    payload = {
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text }], ...(isError && { isError: true }) },
    };
    send(payload);
    function send(result, session) {
      if (session) res.setHeader("mcp-session-id", session);
      if (req.url === "/sse") {
        res.setHeader("Content-Type", "text/event-stream");
        return res.end(`data: ${JSON.stringify(result)}\n\n`);
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }
  });
}).listen(4715, () => console.log("zo-ready"));
