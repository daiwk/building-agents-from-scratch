import { createHash } from "node:crypto";
import type {
  ArtifactEvaluator,
  ArtifactVersion,
  EvalCase,
  EvalSampleResult,
} from "../evolution/index.js";
import type {
  RecordedTrace,
  ReplayEvalCase,
  ReplayEvent,
  ReplayResult,
} from "./types.js";

/** 重放已经完成的模型/工具轨迹，不访问模型或真实工具。 */
export class TraceReplayEvaluator {
  private readonly cases: Map<string, ReplayEvalCase>;

  constructor(dataset: readonly ReplayEvalCase[]) {
    validateReplayDataset(dataset);
    this.cases = new Map(dataset.map((testCase) => [testCase.id, structuredClone(testCase)]));
  }

  replay(artifact: ArtifactVersion, testCase: EvalCase): ReplayResult {
    const fixture = this.cases.get(testCase.id);
    if (!fixture) throw new Error(`Replay case not found: ${testCase.id}`);
    const run = fixture.runs[String(artifact.version)];
    if (!run) throw new Error(`No recorded run for ${testCase.id}@${artifact.version}`);
    validateTraceEvents(run.events);
    const result: EvalSampleResult = {
      output: run.output,
      passed: fixture.rubric === "equals"
        ? run.output.trim() === fixture.expected.trim()
        : run.output.includes(fixture.expected),
      safetyPassed: run.safetyPassed,
      tokens: run.tokens,
      cost: run.cost,
      latencyMs: run.latencyMs,
    };
    return {
      caseId: fixture.id,
      artifactVersion: artifact.version,
      events: structuredClone(run.events),
      result,
    };
  }

  asEvaluator(): ArtifactEvaluator {
    return async (artifact, testCase) => this.replay(artifact, testCase).result;
  }
}

export function promoteTraceToCase(
  trace: RecordedTrace,
  input: {
    id: string;
    split: "eval" | "holdout";
    expected: string;
    rubric: "equals" | "contains";
  },
): ReplayEvalCase {
  validateTraceEvents(trace.events);
  return {
    id: input.id,
    input: trace.input,
    split: input.split,
    expected: input.expected,
    rubric: input.rubric,
    runs: {
      [String(trace.artifactVersion)]: {
        artifactVersion: trace.artifactVersion,
        output: trace.output,
        safetyPassed: trace.safetyPassed,
        tokens: trace.tokens,
        cost: trace.cost,
        latencyMs: trace.latencyMs,
        events: structuredClone(trace.events),
      },
    },
  };
}

export function toEvalCases(dataset: readonly ReplayEvalCase[]): EvalCase[] {
  return dataset.map((item) => ({
    id: item.id,
    input: item.input,
    split: item.split,
    expected: item.expected,
  }));
}

export function datasetFingerprint(dataset: readonly ReplayEvalCase[]): string {
  const canonical = [...dataset]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => JSON.stringify(sortJson(item)))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function validateReplayDataset(dataset: readonly ReplayEvalCase[]): void {
  if (dataset.length === 0) throw new Error("Replay dataset cannot be empty.");
  const ids = new Set<string>();
  for (const testCase of dataset) {
    if (!testCase.id.trim() || ids.has(testCase.id)) throw new Error(`Invalid or duplicate replay id: ${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.input.trim() || !testCase.expected) throw new Error(`Replay case ${testCase.id} needs input and expected output.`);
    if (testCase.split !== "eval" && testCase.split !== "holdout") throw new Error(`Invalid replay split: ${testCase.split}`);
    if (testCase.rubric !== "equals" && testCase.rubric !== "contains") throw new Error(`Invalid replay rubric: ${testCase.rubric}`);
    if (Object.keys(testCase.runs).length === 0) throw new Error(`Replay case ${testCase.id} has no runs.`);
    for (const [version, run] of Object.entries(testCase.runs)) {
      if (String(run.artifactVersion) !== version) throw new Error(`Replay version key mismatch in ${testCase.id}.`);
      validateRun(run, testCase.id);
    }
  }
  if (!dataset.some((item) => item.split === "eval") || !dataset.some((item) => item.split === "holdout")) {
    throw new Error("Replay dataset needs both eval and holdout splits.");
  }
}

function validateRun(run: RecordedTrace | ReplayEvalCase["runs"][string], id: string): void {
  for (const [name, value] of [["tokens", run.tokens], ["cost", run.cost], ["latencyMs", run.latencyMs]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name} in replay ${id}.`);
  }
  validateTraceEvents(run.events);
}

export function validateTraceEvents(events: readonly ReplayEvent[]): void {
  if (events[0]?.type !== "agentStart" || events.at(-1)?.type !== "agentEnd") {
    throw new Error("Replay trace must start with agentStart and end with agentEnd.");
  }
  const activeCalls = new Set<string>();
  for (const event of events) {
    if (event.type === "toolStart") {
      if (activeCalls.has(event.callId)) throw new Error(`Duplicate tool call: ${event.callId}`);
      activeCalls.add(event.callId);
    }
    if (event.type === "toolEnd" && !activeCalls.delete(event.callId)) {
      throw new Error(`toolEnd has no matching toolStart: ${event.callId}`);
    }
  }
  if (activeCalls.size > 0) throw new Error("Replay trace contains unfinished tool calls.");
}
