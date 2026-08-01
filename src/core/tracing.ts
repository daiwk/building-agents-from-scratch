import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type TraceAttribute = string | number | boolean;
export type TraceAttributes = Record<string, TraceAttribute>;
export type TraceStatusCode = "UNSET" | "OK" | "ERROR";

/** 接近 OpenTelemetry SpanData 的最小、稳定 JSON 结构。时间使用 Unix 纳秒字符串。 */
export type TraceSpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "INTERNAL" | "CLIENT";
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: TraceAttributes;
  status: { code: TraceStatusCode; message?: string };
};

/** 生产环境可以实现这个小接口，把 span 转交给真正的 OTel SDK/exporter。 */
export type TraceExporter = {
  export(span: TraceSpanRecord): Promise<void> | void;
};

export type StartSpanOptions = {
  parent?: TraceSpan;
  kind?: TraceSpanRecord["kind"];
  attributes?: TraceAttributes;
};

/**
 * Tracer 只负责创建 span，不知道 Agent、模型或工具的具体实现。
 * exporter 失败默认不会打断 Agent 主流程，调用者可通过 onExportError 接入日志系统。
 */
export class AgentTracer {
  constructor(
    private readonly exporter: TraceExporter,
    private readonly onExportError: (error: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  startSpan(name: string, options: StartSpanOptions = {}): TraceSpan {
    return new TraceSpan(
      this,
      name,
      options.parent?.traceId ?? randomHex(16),
      randomHex(8),
      options.parent?.spanId,
      options.kind ?? "INTERNAL",
      options.attributes ?? {},
      unixNano(this.now()),
    );
  }

  async finish(record: TraceSpanRecord): Promise<void> {
    try {
      await this.exporter.export(record);
    } catch (error) {
      this.onExportError(error);
    }
  }

  timestamp(): string {
    return unixNano(this.now());
  }
}

export class TraceSpan {
  private ended = false;

  constructor(
    private readonly tracer: AgentTracer,
    readonly name: string,
    readonly traceId: string,
    readonly spanId: string,
    readonly parentSpanId: string | undefined,
    private readonly kind: TraceSpanRecord["kind"],
    private readonly initialAttributes: TraceAttributes,
    private readonly startTimeUnixNano: string,
  ) {}

  async end(
    code: TraceStatusCode = "OK",
    attributes: TraceAttributes = {},
    error?: unknown,
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const message = error instanceof Error ? error.message : undefined;
    await this.tracer.finish({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      kind: this.kind,
      startTimeUnixNano: this.startTimeUnixNano,
      endTimeUnixNano: this.tracer.timestamp(),
      attributes: {
        ...this.initialAttributes,
        ...attributes,
        ...(error instanceof Error
          ? { "error.type": error.name, "error.message": error.message }
          : {}),
      },
      status: { code, ...(message ? { message } : {}) },
    });
  }
}

/** 一行一个 span，既适合教学查看，也方便 jq、Vector 或 Fluent Bit 采集。 */
export class JsonlTraceExporter implements TraceExporter {
  private pending: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("Trace file path cannot be empty.");
    this.filePath = resolve(filePath);
  }

  export(span: TraceSpanRecord): Promise<void> {
    const line = `${JSON.stringify(span)}\n`;
    const writing = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });
    // 让单次写入错误返回给 Tracer 记录，但不要让队列永久停留在 rejected 状态。
    this.pending = writing.catch(() => undefined);
    return writing;
  }
}

export function createTracerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  onExportError?: (error: unknown) => void,
): AgentTracer | undefined {
  const filePath = environment.AGENT_TRACE_FILE?.trim();
  if (!filePath) return undefined;
  return new AgentTracer(new JsonlTraceExporter(filePath), onExportError);
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function unixNano(milliseconds: number): string {
  return (BigInt(Math.trunc(milliseconds)) * 1_000_000n).toString();
}
