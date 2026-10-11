// Fake Ollama (4711) + fake streaming Kimi that dies mid-stream (4712). Separate process
// so the synchronous test runner can't block them.
import { createServer } from "node:http";
import fs from "node:fs";
const T = process.argv[2];

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(`${T}/ollama.log`, body + "\n");
    const parsed = JSON.parse(body);
    const userMsg = parsed.messages.find((m) => m.role === "user");
    // canned reply: tests write ${T}/ollama.reply to control the model's answer verbatim
    let content = `OLLAMA: ${userMsg.content}`;
    try { content = fs.readFileSync(`${T}/ollama.reply`, "utf8"); } catch {}
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: { role: "assistant", content } }));
  });
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
