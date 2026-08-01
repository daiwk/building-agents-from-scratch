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
import type { UserContentBlock } from "../core/index.js";
import { InMemoryArtifactStore } from "../artifacts/index.js";
import {
  createAgentFromEnv,
  getProviderName,
  loadLocalEnv,
} from "../runtime/create-agent.js";
import { PLAYGROUND_DEMOS, runPlaygroundDemo } from "./playground.js";
import {
  SecurityError,
  authorize,
  createAuthenticatorFromEnvironment,
  createAuditSinkFromEnvironment,
  scopeTenantSessionId,
  type AuditSink,
  type Authenticator,
  type Permission,
  type Principal,
} from "../security/index.js";

type WebServerOptions = {
  // `?` 表示测试可以传入这些配置，正式运行时也可以全部省略。
  createAgent?: (sessionId?: string, principal?: Principal) => Agent;
  providerName?: string;
  webRoot?: string;
  authenticator?: Authenticator;
  audit?: AuditSink;
};

type ChatBody = {
  message?: unknown;
  sessionId?: unknown;
  artifactIds?: unknown;
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
  const artifacts = new InMemoryArtifactStore();
  const makeAgent = options.createAgent ?? createAgentFromEnv;
  const providerName = options.providerName ?? getProviderName();
  const webRoot = options.webRoot ?? resolve(process.cwd(), "web");
  const authenticator = options.authenticator ?? createAuthenticatorFromEnvironment();
  const audit = options.audit ?? createAuditSinkFromEnvironment();

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    let principal: Principal | undefined;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const requirePermission = (permission: Permission): Principal => {
        principal ??= authenticator.authenticate(request.headers.authorization);
        authorize(principal, permission);
        return principal;
      };

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
      if (request.method === "GET" && url.pathname === "/api/me") {
        principal = authenticator.authenticate(request.headers.authorization);
        return sendJson(response, 200, { principal });
      }
      if (request.method === "GET" && url.pathname === "/api/audit") {
        const identity = requirePermission("audit:read");
        const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
        const events = await audit.list(identity.tenantId, limit);
        await audit.write({
          tenantId: identity.tenantId, subject: identity.subject,
          action: "audit.read", outcome: "success", resourceType: "audit",
          metadata: { limit },
        });
        return sendJson(response, 200, { events });
      }
      if (request.method === "POST" && url.pathname === "/api/artifacts") {
        const identity = requirePermission("artifact:write");
        const body = await readJson(request, 3 * 1024 * 1024);
        if (typeof body.name !== "string" || typeof body.mimeType !== "string" ||
            typeof body.dataBase64 !== "string") {
          return sendJson(response, 400, { error: "name, mimeType and dataBase64 are required." });
        }
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.dataBase64)) {
          return sendJson(response, 400, { error: "dataBase64 is invalid." });
        }
        const data = Buffer.from(body.dataBase64, "base64");
        const artifact = artifacts.create(identity.tenantId, body.name, body.mimeType, data);
        await audit.write({
          tenantId: identity.tenantId, subject: identity.subject,
          action: "artifact.create", outcome: "success", resourceType: "artifact",
          resourceId: artifact.id, metadata: { mimeType: artifact.mimeType, size: artifact.size },
        });
        return sendJson(response, 201, artifacts.metadata(artifact));
      }
      const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([\w-]+)$/);
      if (request.method === "GET" && artifactMatch) {
        const identity = requirePermission("artifact:read");
        const artifact = artifacts.get(identity.tenantId, artifactMatch[1]!);
        if (!artifact) return sendJson(response, 404, { error: "Artifact not found." });
        await audit.write({
          tenantId: identity.tenantId, subject: identity.subject,
          action: "artifact.read", outcome: "success", resourceType: "artifact", resourceId: artifact.id,
        });
        response.writeHead(200, {
          "content-type": artifact.mimeType,
          "content-length": artifact.size,
          "content-disposition": `inline; filename="${artifact.name.replace(/["\\]/g, "_")}"`,
          "cache-control": "private, no-store",
        });
        return response.end(artifact.data);
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const identity = requirePermission("chat:run");
        return await handleChat(
          request,
          response,
          sessions,
          activeSessions,
          makeAgent,
          providerName,
          artifacts,
          identity,
          audit,
        );
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        const identity = requirePermission("session:reset");
        const body = await readJson(request);
        const sessionId =
          typeof body.sessionId === "string" ? body.sessionId : "";
        if (sessionId) {
          if (!/^[\w-]{1,80}$/.test(sessionId)) {
            return sendJson(response, 400, { error: "Invalid session id." });
          }
          // reset 不仅删除内存中的 Agent，也清除可选的持久化 memory。
          const sessionKey = scopeTenantSessionId(identity.tenantId, sessionId);
          const agent = sessions.get(sessionKey) ?? makeAgent(sessionKey, identity);
          await agent.reset();
          sessions.delete(sessionKey);
          await audit.write({
            tenantId: identity.tenantId, subject: identity.subject,
            action: "session.reset", outcome: "success", resourceType: "session", resourceId: sessionId,
          });
        }
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET") {
        return serveStatic(url.pathname, webRoot, response);
      }
      sendJson(response, 404, { error: "Route not found." });
    } catch (error) {
      if (!response.headersSent) {
        if (principal) {
          await audit.write({
            tenantId: principal.tenantId, subject: principal.subject,
            action: `${request.method ?? "UNKNOWN"} ${request.url ?? "/"}`,
            outcome: error instanceof SecurityError ? "denied" : "failure",
          });
        }
        if (error instanceof SecurityError) {
          if (error.statusCode === 401) response.setHeader("www-authenticate", 'Bearer realm="agent"');
          sendJson(response, error.statusCode, { error: error.message });
        } else sendJson(response, 500, { error: toErrorMessage(error) });
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
  makeAgent: (sessionId?: string, principal?: Principal) => Agent,
  providerName: string,
  artifacts: InMemoryArtifactStore,
  principal: Principal,
  audit: AuditSink,
): Promise<void> {
  const body = (await readJson(request)) as ChatBody;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const artifactIds = Array.isArray(body.artifactIds)
    ? body.artifactIds.filter((id): id is string => typeof id === "string") : [];
  if (artifactIds.length > 4) return sendJson(response, 400, { error: "At most 4 artifacts are allowed." });
  if (!message && !artifactIds.length) return sendJson(response, 400, { error: "Message or artifact is required." });
  const attachedArtifacts = artifactIds.map((id) => artifacts.get(principal.tenantId, id));
  if (attachedArtifacts.some((artifact) => !artifact)) {
    return sendJson(response, 404, { error: "Artifact not found." });
  }
  const content: string | UserContentBlock[] = artifactIds.length
    ? [
        ...(message ? [{ type: "text" as const, text: message }] : []),
        ...attachedArtifacts.map((artifact): UserContentBlock => {
          if (!artifact) throw new Error("Unreachable artifact validation state.");
          if (artifact.mimeType.startsWith("image/")) return {
            type: "image", source: { type: "base64", mediaType: artifact.mimeType, data: artifact.data.toString("base64") },
          };
          return { type: "text", text: `\n<uploaded_file name="${artifact.name}">\n${artifact.data.toString("utf8")}\n</uploaded_file>` };
        }),
      ]
    : message;

  const requestedId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const sessionId = requestedId || randomUUID();
  if (!/^[\w-]{1,80}$/.test(sessionId)) {
    return sendJson(response, 400, { error: "Invalid session id." });
  }
  const sessionKey = scopeTenantSessionId(principal.tenantId, sessionId);
  if (activeSessions.has(sessionKey)) {
    return sendJson(response, 409, {
      error: "This session is already processing a message.",
    });
  }

  let agent = sessions.get(sessionKey);
  if (!agent) {
    agent = makeAgent(sessionKey, principal);
    if (sessions.size >= 100) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest) sessions.delete(oldest);
    }
    sessions.set(sessionKey, agent);
  }

  response.writeHead(200, {
    // NDJSON = 每一行一个 JSON。服务端可以产生一个事件就立即发送一个。
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  activeSessions.add(sessionKey);
  const controller = new AbortController();
  // 用户停止请求或关闭页面时，把取消信号继续传给 Agent 和模型请求。
  request.once("aborted", () => controller.abort());

  writeNdjson(response, { type: "session", sessionId, provider: providerName });
  try {
    for await (const event of agent.run(content, {
      signal: controller.signal,
    })) {
      // UI 只需要可观察的控制流，不发送内部 thinking 和重复的完整 assistant 消息。
      if (event.type === "thinking" || event.type === "message") continue;
      writeNdjson(response, event);
    }
    await audit.write({
      tenantId: principal.tenantId, subject: principal.subject,
      action: "chat.run", outcome: "success", resourceType: "session", resourceId: sessionId,
      metadata: { artifactCount: artifactIds.length },
    });
  } catch (error) {
    await audit.write({
      tenantId: principal.tenantId, subject: principal.subject,
      action: "chat.run", outcome: "failure", resourceType: "session", resourceId: sessionId,
      metadata: { errorType: error instanceof Error ? error.name : "unknown" },
    });
    writeNdjson(response, { type: "error", message: toErrorMessage(error) });
  } finally {
    activeSessions.delete(sessionKey);
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

function readJson(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
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
  const host = process.env.AGENT_HOST?.trim() || "127.0.0.1";
  assertSafeBind(host, process.env.AGENT_AUTH_CONFIG);
  const server = createWebServer();
  server.listen(port, host, () => {
    console.log(`Agent Observatory listening on ${host}:${port}`);
    console.log(`provider=${getProviderName()}`);
  });
}

export function assertSafeBind(host: string, authConfig: string | undefined): void {
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!loopback.has(host) && !authConfig?.trim()) {
    throw new Error("Refusing a non-loopback bind without AGENT_AUTH_CONFIG.");
  }
}
