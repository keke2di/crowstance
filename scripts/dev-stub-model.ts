import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const host = process.env.STUB_MODEL_HOST ?? "127.0.0.1";
const port = Number(process.env.STUB_MODEL_PORT ?? "4097");
let requestNumber = 0;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function completion(id: string, model: string, text: string) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: text.length, total_tokens: text.length + 1 },
  };
}

function writeSse(res: ServerResponse, id: string, model: string, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: text.length, total_tokens: text.length + 1 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: "stub-model", object: "model", owned_by: "crowstance-dev" }] });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    json(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
    return;
  }

  const raw = await readBody(req);
  let body: { model?: string; stream?: boolean } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    json(res, 400, { error: { message: "invalid JSON", type: "invalid_request_error" } });
    return;
  }
  requestNumber += 1;
  const id = `stub-${requestNumber}`;
  const text = `stub reply: ${requestNumber}`;
  console.error(`[stub-model] POST /v1/chat/completions model=${body.model ?? "unknown"} stream=${body.stream === true}`);
  if (body.stream === true) writeSse(res, id, body.model ?? "stub-model", text);
  else json(res, 200, completion(id, body.model ?? "stub-model", text));
});

server.listen(port, host, () => console.error(`[stub-model] listening on http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
