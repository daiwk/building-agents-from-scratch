import { createReadStream, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Agent } from "../core/index.js";
import {
  createAgentFromEnv,
  getProviderName,
  loadLocalEnv,
} from "../runtime/create-agent.js";
import { PLAYGROUND_DEMOS, runPlaygroundDemo } from "./playground.js";

type WebServerOptions = {
  // `?` 表示测试可以传入这些配置，正式运行时也可以全部省略。
  createAgent?: (sessionId?: string) => Agent;
  providerName?: string;
  webRoot?: string;
};

type ChatBody = {
  message?: unknown;
  sessionId?: unknown;
};

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createWebServer(options: WebServerOptions = {}): Server {
  // Map<会话 id, Agent> 让同一浏览器的多轮对话共享短期记忆。
  const sessions = new Map<string, Agent>();
  // Set 只记录正在运行的 id，防止一个会话同时修改同一份消息历史。
  const activeSessions = new Set<string>();
  const makeAgent = options.createAgent ?? createAgentFromEnv;
  const providerName = options.providerName ?? getProviderName();
  const webRoot = options.webRoot ?? resolve(process.cwd(), "web");

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true, provider: providerName });
      }
      if (request.method === "GET" && url.pathname === "/api/playground/demos") {
        return sendJson(response, 200, { demos: PLAYGROUND_DEMOS });
      }
      if (request.method === "POST" && url.pathname === "/api/playground/run") {
        const body = await readJson(request);
        const demo = typeof body.demo === "string" ? body.demo : "";
        return sendJson(response, 200, await runPlaygroundDemo(demo));
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        return await handleChat(
          request,
          response,
          sessions,
          activeSessions,
          makeAgent,
          providerName,
        );
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        const body = await readJson(request);
        const sessionId =
          typeof body.sessionId === "string" ? body.sessionId : "";
        if (sessionId) {
          if (!/^[\w-]{1,80}$/.test(sessionId)) {
            return sendJson(response, 400, { error: "Invalid session id." });
          }
          // reset 不仅删除内存中的 Agent，也清除可选的持久化 memory。
          const agent = sessions.get(sessionId) ?? makeAgent(sessionId);
          await agent.reset();
          sessions.delete(sessionId);
        }
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET") {
        return serveStatic(url.pathname, webRoot, response);
      }
      sendJson(response, 404, { error: "Route not found." });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, { error: toErrorMessage(error) });
      } else if (!response.writableEnded) {
        writeNdjson(response, { type: "error", message: toErrorMessage(error) });
        response.end();
      }
    }
  });
}

async function handleChat(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, Agent>,
  activeSessions: Set<string>,
  makeAgent: (sessionId?: string) => Agent,
  providerName: string,
): Promise<void> {
  const body = (await readJson(request)) as ChatBody;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return sendJson(response, 400, { error: "Message is required." });

  const requestedId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const sessionId = requestedId || randomUUID();
  if (!/^[\w-]{1,80}$/.test(sessionId)) {
    return sendJson(response, 400, { error: "Invalid session id." });
  }
  if (activeSessions.has(sessionId)) {
    return sendJson(response, 409, {
      error: "This session is already processing a message.",
    });
  }

  let agent = sessions.get(sessionId);
  if (!agent) {
    agent = makeAgent(sessionId);
    if (sessions.size >= 100) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest) sessions.delete(oldest);
    }
    sessions.set(sessionId, agent);
  }

  response.writeHead(200, {
    // NDJSON = 每一行一个 JSON。服务端可以产生一个事件就立即发送一个。
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  activeSessions.add(sessionId);
  const controller = new AbortController();
  // 用户停止请求或关闭页面时，把取消信号继续传给 Agent 和模型请求。
  request.once("aborted", () => controller.abort());

  writeNdjson(response, { type: "session", sessionId, provider: providerName });
  try {
    for await (const event of agent.run(message, {
      signal: controller.signal,
    })) {
      // UI 只需要可观察的控制流，不发送内部 thinking 和重复的完整 assistant 消息。
      if (event.type === "thinking" || event.type === "message") continue;
      writeNdjson(response, event);
    }
  } catch (error) {
    writeNdjson(response, { type: "error", message: toErrorMessage(error) });
  } finally {
    activeSessions.delete(sessionId);
    response.end();
  }
}

function serveStatic(
  pathname: string,
  webRoot: string,
  response: ServerResponse,
): void {
  const route = pathname === "/" ? "/index.html" : pathname;
  const allowed = new Set([
    "/index.html", "/styles.css", "/app.js",
    "/playground.html", "/playground.css", "/playground.js",
  ]);
  if (!allowed.has(route)) {
    return sendJson(response, 404, { error: "File not found." });
  }

  const filePath = resolve(webRoot, route.slice(1));
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error("Not a file.");
    response.writeHead(200, {
      "content-type":
        MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "File not found." });
  }
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveBody(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: object,
): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  response.end(json);
}

function writeNdjson(response: ServerResponse, value: object): void {
  response.write(`${JSON.stringify(value)}\n`);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  loadLocalEnv();
  const port = Number(process.env.PORT ?? 3000);
  const server = createWebServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Agent Observatory: http://127.0.0.1:${port}`);
    console.log(`provider=${getProviderName()}`);
  });
}
