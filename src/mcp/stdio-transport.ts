import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonValue } from "../core/index.js";
import type { McpRequestTransport } from "./types.js";

type Pending = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  cleanup(): void;
};

/** newline-delimited JSON-RPC stdio transport；command/args 只能由宿主配置。 */
export class StdioMcpTransport implements McpRequestTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, Pending>();
  private nextId = 1;

  constructor(command: string, args: readonly string[] = [], cwd?: string) {
    if (!command.trim()) throw new Error("MCP command is required.");
    this.child = spawn(command, [...args], {
      ...(cwd ? { cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code) => this.rejectAll(
      new Error(`MCP process exited with code ${code ?? "unknown"}.`),
    ));
  }

  request(
    method: string,
    params: Record<string, JsonValue> = {},
    signal?: AbortSignal,
    requestId?: string | number,
  ): Promise<unknown> {
    const id = requestId ?? this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(signal?.reason ?? new Error(`MCP ${method} cancelled.`));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, JsonValue> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill();
    this.rejectAll(new Error("MCP transport closed."));
  }

  private write(message: object): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
