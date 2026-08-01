import { describe, expect, it } from "vitest";
import { Agent, type ModelProvider } from "../src/core/index.js";
import {
  InMemoryGraphCheckpointStore,
  StateGraph,
} from "../src/graph/index.js";
import {
  AgentEventBus,
  SubagentScheduler,
  runSubagent,
} from "../src/subagents/index.js";

function createAnswerAgent(text: string): Agent {
  const model: ModelProvider = {
    name: "child",
    async generate() {
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { input: 2, output: 3 },
      };
    },
  };
  return new Agent({ model });
}

describe("sub-agent orchestration", () => {
  it("returns a structured handoff and publishes child events", async () => {
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.subscribe((envelope) => events.push(`${envelope.agentId}:${envelope.event.type}`));

    const handoff = await runSubagent({
      task: "research",
      agentId: "child-1",
      parentAgentId: "parent",
      createAgent: () => createAnswerAgent("done"),
      policy: { maxDepth: 2, maxTurns: 2, maxTokens: 20, timeoutMs: 1_000 },
      eventBus: bus,
      parentMessages: [{ role: "user", content: "private" }],
      selectContext: () => [{ role: "user", content: "shared fact" }],
    });

    expect(handoff).toMatchObject({
      status: "completed",
      output: "done",
      agentId: "child-1",
      parentAgentId: "parent",
      depth: 1,
      turns: 1,
      totalTokens: 5,
    });
    expect(events).toContain("child-1:agentEnd");
  });

  it("enforces depth and schedules children with stable result order", async () => {
    await expect(runSubagent({
      task: "too deep",
      agentId: "deep",
      depth: 3,
      policy: { maxDepth: 2 },
      createAgent: () => createAnswerAgent("never"),
    })).rejects.toThrow("depth");

    const scheduler = new SubagentScheduler(2);
    const results = await scheduler.run([
      { task: "a", agentId: "a", createAgent: () => createAnswerAgent("A") },
      { task: "b", agentId: "b", createAgent: () => createAnswerAgent("B") },
    ]);
    expect(results.map((item) => item.output)).toEqual(["A", "B"]);
  });
});

type WorkflowState = { value: number; approved?: boolean; left?: number; right?: number };

describe("StateGraph", () => {
  it("runs conditional edges and parallel branches through a reducer", async () => {
    const graph = new StateGraph<WorkflowState>((state, updates) =>
      Object.assign({}, state, ...updates),
    )
      .addNode("start", () => ({ value: 2 }))
      .addNode("fork", () => ({ fork: ["left", "right"], join: "join" }))
      .addNode("left", (state) => ({ left: state.value + 1 }))
      .addNode("right", (state) => ({ right: state.value + 2 }))
      .addNode("join", (state) => ({ value: (state.left ?? 0) + (state.right ?? 0) }))
      .setStart("start")
      .addEdge("start", "fork", (state) => state.value === 2);

    const result = await graph.run({ value: 0 });

    expect(result).toMatchObject({ status: "completed", state: { value: 7 } });
  });

  it("checkpoints an interrupt and resumes the same node", async () => {
    const checkpoints = new InMemoryGraphCheckpointStore<WorkflowState>();
    const graph = new StateGraph<WorkflowState>(undefined, checkpoints)
      .addNode("approval", (_state, context) => {
        if (context.resumeValue !== "approve") {
          context.interrupt({ question: "approve?" });
        }
        return { approved: true };
      })
      .setStart("approval");

    const paused = await graph.run({ value: 1 }, { checkpointId: "run-1" });
    expect(paused).toMatchObject({ status: "interrupted", value: { question: "approve?" } });

    const resumed = await graph.run(
      { value: 0 },
      { checkpointId: "run-1", resume: true, resumeValue: "approve" },
    );
    expect(resumed).toMatchObject({ status: "completed", state: { value: 1, approved: true } });
    expect(await checkpoints.load("run-1")).toBeUndefined();
  });
});
