// tools/signal-server.js
//
// Minimal stand-in for "a specific signal comes to an api endpoint...
// localhost 2000" — lets you trigger the visual layer on demand while
// developing, without needing the full analysis server running.
//
// Usage:
//   npm install ws
//   node tools/signal-server.js
//   # then, in another terminal, or interactively:
//   node -e "require('ws'); const s=new (require('ws'))('ws://localhost:2000'); \
//            s.on('open',()=>{s.send(JSON.stringify({type:'trigger',task:'demo'}));s.close()})"

import { WebSocketServer } from "ws";

const PORT = 2000;
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  console.log("[signal-server] extension connected");

  ws.on("message", (raw) => {
    console.log("[signal-server] received from extension:", raw.toString());
  });

  ws.on("close", () => console.log("[signal-server] extension disconnected"));
});

console.log(`[signal-server] listening on ws://localhost:${PORT}`);
console.log('Send a trigger with: {"type":"trigger","task":"<optional task string>"}');

// Convenience: broadcast a trigger to every connected client every time you
// press Enter in this terminal, for quick manual testing during a demo.
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  const payload = JSON.stringify({ type: "trigger", task: "manual-signal-server-trigger" });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
  console.log("[signal-server] broadcast trigger to", wss.clients.size, "client(s)");
});
