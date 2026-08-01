import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "../core/index.js";

export type Permission =
  | "chat:run"
  | "artifact:write"
  | "artifact:read"
  | "session:reset"
  | "audit:read"
  | `tool:${string}`
  | `skill:${string}`
  | `resource:${string}`;

export type Principal = {
  subject: string;
  tenantId: string;
  roles: string[];
};

export type ApiKeyIdentity = Principal & {
  id: string;
  /** 只保存 SHA-256；配置文件中不出现明文 API Key。 */
  sha256: string;
};

const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  user: [
    "chat:run", "artifact:write", "artifact:read", "session:reset",
    "tool:calculator", "tool:current_time", "tool:search_knowledge",
  ],
  builder: [
    "chat:run", "artifact:write", "artifact:read", "session:reset",
    "tool:*", "skill:*", "resource:*",
  ],
  auditor: ["audit:read"],
  admin: ["*"],
};

export class SecurityError extends Error {
  constructor(message: string, readonly statusCode: 401 | 403) {
    super(message);
    this.name = "SecurityError";
  }
}

export type Authenticator = {
  authenticate(authorization: string | undefined): Principal;
};

/** Bearer token 只在内存中哈希并做 constant-time 比较，不进入日志。 */
export class ApiKeyAuthenticator implements Authenticator {
  constructor(private readonly identities: readonly ApiKeyIdentity[]) {
    if (!identities.length) throw new Error("At least one API key identity is required.");
    for (const identity of identities) validateIdentity(identity);
  }

  authenticate(authorization: string | undefined): Principal {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) throw new SecurityError("Bearer API key is required.", 401);
    const candidate = createHash("sha256").update(match[1]!).digest();
    let identity: ApiKeyIdentity | undefined;
    // 扫描全部记录，避免“匹配项排在第几个”直接反映在响应时间里。
    for (const item of this.identities) {
      if (timingSafeEqual(candidate, Buffer.from(item.sha256, "hex"))) identity = item;
    }
    if (!identity) throw new SecurityError("Invalid API key.", 401);
    return { subject: identity.subject, tenantId: identity.tenantId, roles: [...identity.roles] };
  }
}

/** 本地教学默认值；部署配置认证文件后不再使用匿名身份。 */
export class LocalDevelopmentAuthenticator implements Authenticator {
  authenticate(): Principal {
    return { subject: "local-developer", tenantId: "local", roles: ["admin"] };
  }
}

export function authorize(principal: Principal, permission: Permission): void {
  const allowed = principal.roles.some((role) =>
    ROLE_PERMISSIONS[role]?.some((pattern) => permissionMatches(pattern, permission))
  );
  if (!allowed) throw new SecurityError(`Permission denied: ${permission}.`, 403);
}

function permissionMatches(pattern: string, permission: string): boolean {
  return pattern === "*" || pattern === permission ||
    (pattern.endsWith("*") && permission.startsWith(pattern.slice(0, -1)));
}

export function hashApiKey(apiKey: string): string {
  if (apiKey.length < 16) throw new Error("API keys must contain at least 16 characters.");
  return createHash("sha256").update(apiKey).digest("hex");
}

/** 外部 session id 可以重复；内部 key 必须把 tenant 纳入不可歧义的命名空间。 */
export function scopeTenantSessionId(tenantId: string, sessionId: string): string {
  return createHash("sha256").update(tenantId).update("\0").update(sessionId).digest("hex");
}

export function createAuthenticatorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Authenticator {
  const configPath = environment.AGENT_AUTH_CONFIG?.trim();
  if (!configPath) return new LocalDevelopmentAuthenticator();
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("AGENT_AUTH_CONFIG must contain a JSON array.");
  return new ApiKeyAuthenticator(parsed as ApiKeyIdentity[]);
}

export type AuditOutcome = "success" | "denied" | "failure";
export type AuditEvent = {
  id: string;
  timestamp: string;
  tenantId: string;
  subject: string;
  action: string;
  outcome: AuditOutcome;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, JsonValue>;
};

export type NewAuditEvent = Omit<AuditEvent, "id" | "timestamp">;

export interface AuditSink {
  write(event: NewAuditEvent): Promise<void> | void;
  list(tenantId: string, limit?: number): Promise<AuditEvent[]> | AuditEvent[];
}

export class InMemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  write(event: NewAuditEvent): void {
    this.events.push(createAuditEvent(event));
  }

  list(tenantId: string, limit = 100): AuditEvent[] {
    return this.events.filter((event) => event.tenantId === tenantId).slice(-limit)
      .map((event) => structuredClone(event));
  }
}

/** JSONL 审计日志只接受宿主生成的 metadata；默认不记录 prompt、文件内容或 token。 */
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  async write(event: NewAuditEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(createAuditEvent(event)) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  async list(tenantId: string, limit = 100): Promise<AuditEvent[]> {
    let text = "";
    try { text = await readFile(this.filePath, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditEvent)
      .filter((event) => event.tenantId === tenantId).slice(-limit);
  }
}

export function createAuditSinkFromEnvironment(environment: NodeJS.ProcessEnv = process.env): AuditSink {
  const filePath = environment.AGENT_AUDIT_FILE?.trim();
  return filePath ? new JsonlAuditSink(filePath) : new InMemoryAuditSink();
}

/** 支持 Docker/Kubernetes 常见的 *_FILE secret，不提供列举接口。 */
export class EnvironmentSecretProvider {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  get(name: string): string | undefined {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Invalid secret name.");
    const filePath = this.environment[`${name}_FILE`]?.trim();
    const value = filePath ? readFileSync(filePath, "utf8").trim() : this.environment[name];
    return value || undefined;
  }

  require(name: string): string {
    const value = this.get(name);
    if (!value) throw new Error(`Required secret is unavailable: ${name}.`);
    return value;
  }
}

function createAuditEvent(event: NewAuditEvent): AuditEvent {
  return { id: randomUUID(), timestamp: new Date().toISOString(), ...structuredClone(event) };
}

function validateIdentity(identity: ApiKeyIdentity): void {
  if (!/^[\w.-]{1,120}$/.test(identity.id)) throw new Error("Invalid identity id.");
  if (!/^[\w.-]{1,120}$/.test(identity.subject)) throw new Error("Invalid subject.");
  if (!/^[\w.-]{1,120}$/.test(identity.tenantId)) throw new Error("Invalid tenant id.");
  if (!/^[a-f0-9]{64}$/.test(identity.sha256)) throw new Error("Identity sha256 must be lowercase hex.");
  if (!identity.roles.length || identity.roles.some((role) => !ROLE_PERMISSIONS[role])) {
    throw new Error("Identity contains an unknown role.");
  }
}
