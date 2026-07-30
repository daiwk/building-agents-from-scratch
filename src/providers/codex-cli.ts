import { spawn } from "node:child_process";
import type {
  AgentMessage,
  AssistantMessage,
  ModelProvider,
  ModelRequest,
} from "../core/index.js";

export type CodexCliProviderOptions = {
  executable?: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
};

/**
 * Experimental adapter for the local Codex CLI.
 *
 * Codex is already an agent rather than a raw LLM API. This adapter therefore
 * supports conversation only; use MiniMax when demonstrating this project's
 * own tool loop.
 */
export class CodexCliProvider implements ModelProvider {
  readonly name = "codex-cli";
  private readonly options: CodexCliProviderOptions;

  constructor(options: CodexCliProviderOptions = {}) {
    this.options = options;
  }

  async generate(request: ModelRequest): Promise<AssistantMessage> {
    if (request.tools.length > 0) {
      throw new Error(
        `${this.name} cannot expose this project's tools. ` +
          "The CLI is already an agent; use MiniMax to study the local tool loop.",
      );
    }

    const prompt = renderPrompt(request.systemPrompt, request.messages);
    const executable = this.options.executable ?? "codex";
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      ...(this.options.model ? ["--model", this.options.model] : []),
      "-",
    ];
    const text = await runCommand(
      executable,
      args,
      prompt,
      this.options.cwd,
      this.options.timeoutMs ?? 120_000,
      request.signal,
    );

    return {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    };
  }
}

function renderPrompt(
  systemPrompt: string,
  messages: readonly AgentMessage[],
): string {
  const history = messages
    .map((message) => {
      if (message.role === "user") return `USER:\n${message.content}`;
      if (message.role === "tool") {
        return `TOOL ${message.toolName}:\n${message.content}`;
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return `ASSISTANT:\n${text}`;
    })
    .join("\n\n");

  return [
    "Follow the system instruction and answer the final user message.",
    `SYSTEM:\n${systemPrompt}`,
    `CONVERSATION:\n${history}`,
  ].join("\n\n");
}

function runCommand(
  executable: string,
  args: string[],
  stdin: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error(`${executable} was aborted.`));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${executable} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0 && output) return finish(undefined, output);
      const details = Buffer.concat(stderr).toString("utf8").trim();
      finish(
        new Error(
          `${executable} exited with code ${code ?? "unknown"}: ${details}`,
        ),
      );
    });

    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(stdin);
  });
}
