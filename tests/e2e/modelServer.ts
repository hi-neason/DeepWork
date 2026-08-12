import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestModelServer {
  baseUrl: string;
  authorizationHeaders: string[];
  close(): Promise<void>;
}

/** Deterministic OpenAI-compatible server used through the real Electron network stack. */
export async function startTestModelServer(): Promise<TestModelServer> {
  const authorizationHeaders: string[] = [];
  const server = http.createServer((request, response) => {
    authorizationHeaders.push(request.headers.authorization ?? "");
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "deepwork-e2e-model" }] }));
      return;
    }
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (!parsed.stream) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: "chatcmpl-e2e", object: "chat.completion", created: 1,
            model: "deepwork-e2e-model",
            choices: [{ index: 0, message: { role: "assistant", content: "E2E stream complete" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
          }));
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunks = ["E2E ", "stream ", "complete"];
        chunks.forEach((content, index) => {
          response.write(`data: ${JSON.stringify({
            id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1,
            model: "deepwork-e2e-model",
            choices: [{ index: 0, delta: index === 0 ? { role: "assistant", content } : { content }, finish_reason: null }],
          })}\n\n`);
        });
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1,
          model: "deepwork-e2e-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    authorizationHeaders,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
