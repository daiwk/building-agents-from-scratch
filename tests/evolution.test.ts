import { describe, expect, it } from "vitest";
import {
  EvolutionController,
  InMemoryArtifactStore,
  type ArtifactVersion,
  type EvalCase,
} from "../src/evolution/index.js";

const baseline: ArtifactVersion = {
  artifactId: "assistant-prompt",
  kind: "prompt",
  version: 1,
  content: "old prompt",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const dataset: EvalCase[] = [
  { id: "public-1", input: "公开问题", split: "eval" },
  { id: "secret-1", input: "隐藏问题", split: "holdout" },
];

function createStore() {
  const store = new InMemoryArtifactStore();
  store.put(baseline);
  store.activate(baseline.artifactId, baseline.version);
  return store;
}

describe("controlled self-evolve", () => {
  it("evaluates the same fixed dataset, requires approval, publishes, and rolls back", async () => {
    const store = createStore();
    const controller = new EvolutionController(store, dataset, async (artifact) => ({
      output: artifact.version === 2 ? "good" : "bad",
      passed: artifact.version === 2,
      safetyPassed: true,
      tokens: 10,
      cost: 0.01,
      latencyMs: 20,
    }));

    const proposed = controller.propose({
      artifactId: "assistant-prompt",
      kind: "prompt",
      content: "improved prompt",
      rationale: "fix trace failures",
      failureTraceIds: ["trace-7"],
    });
    const stale = controller.propose({
      artifactId: "assistant-prompt",
      kind: "prompt",
      content: "another prompt based on v1",
      rationale: "parallel proposal",
      failureTraceIds: ["trace-9"],
    });
    expect(() => controller.publish(proposed.id, "maintainer")).toThrow("approved");

    const evaluated = await controller.evaluate(proposed.id);
    expect(evaluated.report?.gate).toEqual({ passed: true, reasons: [] });
    controller.approve(proposed.id, "human-reviewer", "checked samples");
    controller.publish(proposed.id, "release-owner");
    expect(store.getActive("assistant-prompt")?.version).toBe(2);
    const monitoring = await controller.monitorActive("assistant-prompt");
    expect(monitoring.report.gate.passed).toBe(true);
    expect(controller.monitoringHistory()).toHaveLength(1);

    await controller.evaluate(stale.id);
    controller.approve(stale.id, "human-reviewer");
    expect(() => controller.publish(stale.id, "release-owner")).toThrow("changed after proposal");

    controller.rollback("assistant-prompt", 1, "on-call");
    expect(store.getActive("assistant-prompt")?.version).toBe(1);
    expect(controller.releaseHistory().map((item) => item.action)).toEqual(["publish", "rollback"]);
  });

  it("blocks regressions, unsafe output, missing holdout, and mutable versions", async () => {
    const store = createStore();
    const controller = new EvolutionController(store, dataset, async (artifact, testCase) => ({
      output: "answer",
      passed: artifact.version === 1 || testCase.split === "eval",
      safetyPassed: artifact.version === 1,
      tokens: artifact.version === 1 ? 10 : 30,
      cost: 0,
      latencyMs: 10,
    }));
    const candidate = controller.propose({
      artifactId: "assistant-prompt",
      kind: "prompt",
      content: "overfit prompt",
      rationale: "only fixes public cases",
      failureTraceIds: ["trace-8"],
    });
    const evaluated = await controller.evaluate(candidate.id);
    expect(evaluated.report?.gate.passed).toBe(false);
    expect(evaluated.report?.gate.reasons).toContain("holdout pass rate below minimum");
    expect(evaluated.report?.gate.reasons).toContain("safety check failed");
    expect(() => controller.approve(candidate.id, "reviewer")).toThrow("failed release gate");
    expect(() => store.put(baseline)).toThrow("already exists");
    expect(() => new EvolutionController(store, [dataset[0]!], async () => ({
      output: "", passed: true, safetyPassed: true, tokens: 0, cost: 0, latencyMs: 0,
    }))).toThrow("holdout");
  });
});
