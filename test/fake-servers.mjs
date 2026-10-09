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
