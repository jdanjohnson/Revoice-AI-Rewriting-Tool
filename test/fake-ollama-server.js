#!/usr/bin/env node
// Minimal fake Ollama /api/chat used to exercise the CLI's fallback path.
import { createServer } from "node:http";

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const userMsg = parsed.messages.find((m) => m.role === "user");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: `OLLAMA(${parsed.model}): ${userMsg.content}` },
        })
      );
    });
  } else {
    res.statusCode = 404;
    res.end();
  }
}).listen(4598, () => console.log("fake ollama on http://127.0.0.1:4598/"));
