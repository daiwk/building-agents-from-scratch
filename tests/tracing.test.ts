import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Agent,
  AgentTracer,
  JsonlTraceExporter,
  type AssistantMessage,
  type ModelProvider,
  type TraceSpanRecord,
} from "../src/core/index.js";
import { calculatorTool } from "../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("Agent tracing", () => {
  it("creates one trace with run, model, and tool spans", async () => {
    const records: TraceSpanRecord[] = [];
    const tracer = new AgentTracer({
      export(span) {
        records.push(span);
      },
    });
    const replies: AssistantMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "trace-call",
          name: "calculator",
          arguments: { operation: "add", left: 1, right: 2 },
        }],
        stopReason: "toolUse",
        usage: { input: 10, output: 3 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "3" }],
        stopReason: "stop",
        usage: { input: 12, output: 1 },
      },
    ];
    let calls = 0;
    const model: ModelProvider = {
      name: "traced-model",
      async generate() {
        const reply = replies[calls++];
        if (!reply) throw new Error("No reply.");
        return reply;
      },
    };
    const agent = new Agent({ model, tools: [calculatorTool], tracer });

    for await (const _event of agent.run("1+2")) {
      // Consume the complete run so the root span can end.
    }

    expect(records.map((record) => record.name)).toEqual([
      "gen_ai.chat",
      "execute_tool calculator",
      "gen_ai.chat",
      "agent.run",
    ]);
    const run = records.at(-1);
    expect(run).toMatchObject({ status: { code: "OK" } });
    expect(run?.traceId).toHaveLength(32);
    expect(run?.spanId).toHaveLength(16);
    expect(records.slice(0, -1).every(
      (record) =>
        record.traceId === run?.traceId &&
        record.parentSpanId === run?.spanId,
    )).toBe(true);
    expect(records[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 3,
    });
  });

  it("writes one JSON object per line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-trace-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "nested", "traces.jsonl");
    const tracer = new AgentTracer(new JsonlTraceExporter(filePath));
    const span = tracer.startSpan("lesson");

    await span.end("OK", { example: true });

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      name: "lesson",
      attributes: { example: true },
      status: { code: "OK" },
    });
  });

  it("marks model and run spans as errors without recording prompts", async () => {
    const records: TraceSpanRecord[] = [];
    const tracer = new AgentTracer({
      export(span) {
        records.push(span);
      },
    });
    const model: ModelProvider = {
      name: "broken",
      async generate() {
        throw new Error("provider failed");
      },
    };
    const agent = new Agent({
      model,
      tracer,
      modelCall: { maxRetries: 0 },
    });

    await expect(async () => {
      for await (const _event of agent.run("secret prompt")) {
        // Consume until the provider error reaches the caller.
      }
    }).rejects.toThrow("provider failed");

    expect(records.map((record) => record.status.code)).toEqual([
      "ERROR",
      "ERROR",
    ]);
    expect(JSON.stringify(records)).not.toContain("secret prompt");
  });

  it("does not break the agent when the exporter fails", async () => {
    const errors: unknown[] = [];
    const tracer = new AgentTracer(
      {
        export() {
          throw new Error("collector offline");
        },
      },
      (error) => errors.push(error),
    );
    const model: ModelProvider = {
      name: "healthy-model",
      async generate() {
        return {
          role: "assistant",
          content: [{ type: "text", text: "still works" }],
          stopReason: "stop",
        };
      },
    };
    const agent = new Agent({ model, tracer });
    const events = [];

    for await (const event of agent.run("hello")) events.push(event);

    expect(events.some((event) => event.type === "agentEnd")).toBe(true);
    expect(errors).toHaveLength(2);
  });
});
