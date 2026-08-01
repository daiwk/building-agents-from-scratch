import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareArtifacts, type ArtifactVersion } from "../src/evolution/index.js";
import {
  JsonEvalReportStore,
  JsonlEvalDatasetStore,
  TraceReplayEvaluator,
  datasetFingerprint,
  promoteTraceToCase,
  toEvalCases,
  type ReplayEvalCase,
} from "../src/evals/index.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const artifacts: ArtifactVersion[] = [1, 2].map((version) => ({
  artifactId: "prompt", kind: "prompt", version, content: `v${version}`, createdAt: "2026-01-01T00:00:00Z",
}));
const events = [{ type: "agentStart" }, { type: "agentEnd" }] as const;

function caseFor(id: string, split: "eval" | "holdout"): ReplayEvalCase {
  return {
    id, input: "question", split, expected: "good", rubric: "equals",
    runs: {
      "1": { artifactVersion: 1, output: "bad", safetyPassed: true, tokens: 10, cost: 1, latencyMs: 10, events: [...events] },
      "2": { artifactVersion: 2, output: "good", safetyPassed: true, tokens: 10, cost: 1, latencyMs: 10, events: [...events] },
    },
  };
}

describe("trace replay eval workbench", () => {
  it("persists a fixed JSONL dataset, replays traces, and stores a report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-evals-"));
    directories.push(directory);
    const dataset = [caseFor("public", "eval"), caseFor("hidden", "holdout")];
    const store = new JsonlEvalDatasetStore(join(directory, "dataset.jsonl"));
    store.save(dataset);
    const loaded = store.load();
    const replay = new TraceReplayEvaluator(loaded);
    const report = await compareArtifacts(artifacts[0]!, artifacts[1]!, toEvalCases(loaded), replay.asEvaluator());
    expect(report.gate.passed).toBe(true);
    const saved = { datasetFingerprint: datasetFingerprint(loaded), baselineVersion: 1, candidateVersion: 2, createdAt: "now", report };
    const path = new JsonEvalReportStore(join(directory, "reports")).save(saved);
    expect(new JsonEvalReportStore(directory).load(path)).toEqual(saved);
  });

  it("promotes a trace and rejects incomplete tool pairs", () => {
    const promoted = promoteTraceToCase({
      input: "q", artifactVersion: 1, output: "a", safetyPassed: true,
      tokens: 1, cost: 0, latencyMs: 1, events: [...events],
    }, { id: "case", split: "eval", expected: "a", rubric: "equals" });
    expect(promoted.runs["1"]?.output).toBe("a");
    expect(() => new TraceReplayEvaluator([
      { ...caseFor("public", "eval"), runs: { "1": { ...caseFor("public", "eval").runs["1"]!, events: [{ type: "agentStart" }, { type: "toolStart", callId: "x", name: "t" }, { type: "agentEnd" }] } } },
      caseFor("hidden", "holdout"),
    ])).toThrow("unfinished tool calls");
  });
});
