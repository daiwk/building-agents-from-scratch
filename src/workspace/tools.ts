import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tool } from "../core/index.js";
import { ToolRegistry } from "../tools/index.js";
import {
  InMemoryFileArtifactStore,
  type FileArtifactStore,
} from "./artifacts.js";

export type WorkspaceToolOptions = {
  root: string;
  allowWrite?: boolean;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxEntries?: number;
  maxMatches?: number;
  maxInlineCharacters?: number;
  artifacts?: FileArtifactStore;
};

export type WorkspaceToolKit = {
  registry: ToolRegistry;
  artifacts: FileArtifactStore;
};

/** 创建只在指定 root 内工作的文件工具；默认只读，且从不执行 shell。 */
export function createWorkspaceToolKit(options: WorkspaceToolOptions): WorkspaceToolKit {
  const sandbox = new WorkspaceSandbox(options);
  const artifacts = options.artifacts ?? new InMemoryFileArtifactStore();
  const inlineLimit = positive(options.maxInlineCharacters ?? 8_000, "maxInlineCharacters");
  const format = (name: string, text: string) => {
    if (text.length <= inlineLimit) return text;
    const artifact = artifacts.put({ name, mediaType: "text/plain", content: text });
    return `${text.slice(0, inlineLimit)}\n\n[output truncated; artifact=${artifact.id}; characters=${text.length}]`;
  };
  const tools: Tool[] = [
    {
      name: "read_artifact",
      description: "Read a bounded slice of a previously truncated tool artifact.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      execute(input) {
        const id = requiredString(input.id, "id");
        const offset = optionalNonNegativeInteger(input.offset, 0, "offset");
        const limit = optionalPositiveInteger(input.limit, inlineLimit, "limit");
        const artifact = artifacts.get(id);
        if (!artifact) throw new Error(`Unknown artifact: ${id}`);
        return `[artifact=${id}; offset=${offset}; total=${artifact.content.length}]\n${artifact.content.slice(offset, offset + limit)}`;
      },
    },
    {
      name: "list_files",
      description: "List files below a path inside the authorized workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      execute(input) {
        const path = optionalString(input.path, ".");
        return format("file-list.txt", sandbox.list(path).join("\n"));
      },
    },
    {
      name: "read_file",
      description: "Read one UTF-8 text file inside the authorized workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute(input) {
        const path = requiredString(input.path, "path");
        return format(basename(path), sandbox.read(path));
      },
    },
    {
      name: "search_text",
      description: "Search UTF-8 workspace files without invoking a shell.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute(input) {
        const query = requiredString(input.query, "query");
        const path = optionalString(input.path, ".");
        return format("search-results.txt", sandbox.search(path, query).join("\n"));
      },
    },
  ];
  if (options.allowWrite) {
    tools.push({
      name: "write_file",
      description: "Replace one UTF-8 file inside the authorized workspace. Requires host opt-in.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute(input) {
        const path = requiredString(input.path, "path");
        const content = requiredString(input.content, "content", true);
        sandbox.write(path, content);
        return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
      },
    });
  }
  return { registry: new ToolRegistry().registerMany(tools), artifacts };
}

class WorkspaceSandbox {
  private readonly root: string;
  private readonly maxReadBytes: number;
  private readonly maxWriteBytes: number;
  private readonly maxEntries: number;
  private readonly maxMatches: number;

  constructor(options: WorkspaceToolOptions) {
    this.root = realpathSync(resolve(options.root));
    this.maxReadBytes = positive(options.maxReadBytes ?? 256_000, "maxReadBytes");
    this.maxWriteBytes = positive(options.maxWriteBytes ?? 256_000, "maxWriteBytes");
    this.maxEntries = positive(options.maxEntries ?? 500, "maxEntries");
    this.maxMatches = positive(options.maxMatches ?? 200, "maxMatches");
  }

  list(userPath: string): string[] {
    const start = this.existing(userPath);
    const result: string[] = [];
    this.walk(start, (path) => {
      result.push(relative(this.root, path) || ".");
      return result.length < this.maxEntries;
    });
    return result;
  }

  read(userPath: string): string {
    const path = this.existing(userPath);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("Workspace path is not a file.");
    if (stat.size > this.maxReadBytes) throw new Error(`File exceeds ${this.maxReadBytes} byte limit.`);
    return readFileSync(path, "utf8");
  }

  search(userPath: string, query: string): string[] {
    if (!query) throw new Error("Search query cannot be empty.");
    const start = this.existing(userPath);
    const matches: string[] = [];
    this.walk(start, (path) => {
      if (!lstatSync(path).isFile() || statSync(path).size > this.maxReadBytes) return true;
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch { return true; }
      text.split(/\r?\n/).forEach((line, index) => {
        if (matches.length < this.maxMatches && line.includes(query)) {
          matches.push(`${relative(this.root, path)}:${index + 1}:${line}`);
        }
      });
      return matches.length < this.maxMatches;
    });
    return matches;
  }

  write(userPath: string, content: string): void {
    const bytes = Buffer.byteLength(content);
    if (bytes > this.maxWriteBytes) throw new Error(`Content exceeds ${this.maxWriteBytes} byte limit.`);
    const target = this.writable(userPath);
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  }

  private walk(start: string, visit: (path: string) => boolean): void {
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current) continue;
      if (!visit(current)) return;
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const entries = readdirSync(current, { withFileTypes: true })
        .filter((entry) => ![".git", "node_modules", ".agent-data"].includes(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) pending.push(join(current, entry.name));
      }
    }
  }

  private existing(userPath: string): string {
    const candidate = this.lexical(userPath);
    const real = realpathSync(candidate);
    this.assertInside(real);
    return real;
  }

  private writable(userPath: string): string {
    const candidate = this.lexical(userPath);
    const parent = realpathSync(dirname(candidate));
    this.assertInside(parent);
    return join(parent, basename(candidate));
  }

  private lexical(userPath: string): string {
    if (!userPath || userPath.includes("\0") || isAbsolute(userPath)) {
      throw new Error("Workspace path must be a non-empty relative path.");
    }
    const candidate = resolve(this.root, userPath);
    this.assertInside(candidate);
    return candidate;
  }

  private assertInside(path: string): void {
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error("Path escapes the authorized workspace.");
    }
  }
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new Error(`${name} must be a string.`);
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  return value === undefined ? fallback : requiredString(value, "path");
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function optionalNonNegativeInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value as number;
}

function optionalPositiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  return positive(value as number, name);
}
