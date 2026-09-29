import { describe, expect, it, vi } from "vitest";
import {
  RegularizedRsiController,
  calibrateNoiseBand,
  type AtomicHarnessEdit,
  type HarnessGrade,
} from "../src/rsi/index.js";

const initial = {
  id: "research-agent",
  version: 1,
  content: "base harness",
  createdAt: "2026-09-01T00:00:00Z",
};

const grades: Record<string, HarnessGrade> = {
  expensive: { publicScore: 0.62, selectionScore: 0.60, policyTokens: 200, safetyPassed: true },
  negative: { publicScore: 0.40, selectionScore: 0.49, policyTokens: 100, safetyPassed: true },
  reusable: { publicScore: 0.59, selectionScore: 0.58, policyTokens: 105, safetyPassed: true },
  recursive: { publicScore: 0.64, selectionScore: 0.63, policyTokens: 106, safetyPassed: true },
};

describe("regularized recursive self-improvement", () => {
  it("screens leakage, regularizes selection, and makes the winner the next parent", async () => {
    const grader = vi.fn(async (harness) => grades[harness.content]!);
    const controller = new RegularizedRsiController(
      initial,
      { publicScore: 0.5, selectionScore: 0.5, policyTokens: 100, safetyPassed: true },
      grader,
      { totalRounds: 4, minEditBudget: 1, maxEditBudget: 3, noiseBand: 0.02 },
      ["secret-case-42"],
    );

    expect(controller.editBudget(0)).toBe(3);
    expect(controller.editBudget(4)).toBe(1);
    const leaked = controller.propose("leak", [edit("leak", "prompt", "mention secret-case-42")]);
    expect(leaked.status).toBe("screened_out");
    await expect(controller.evaluate(leaked.id)).rejects.toThrow("Screened");
    expect(grader).not.toHaveBeenCalled();

    const expensive = controller.propose("expensive", [edit("big", "control_flow", "+more loops")]);
    const negative = controller.propose("negative", [edit("bad-memory", "memory", "+unused cache")]);
    const reusable = controller.propose("reusable", [edit("retry", "config", "+bounded retry")]);
    const expensiveResult = await controller.evaluate(expensive.id);
    await controller.evaluate(negative.id);
    const reusableResult = await controller.evaluate(reusable.id);
    expect(JSON.stringify(reusableResult)).not.toContain("selectionScore");
    expect(expensiveResult.selection?.reasons).toContain("cost growth is not justified by score gain");
    expect(reusableResult.selection?.admissible).toBe(true);
    expect(() => controller.select([reusable.id], "human-reviewer"))
      .toThrow("every candidate");

    const winner = controller.select(
      [leaked.id, expensive.id, negative.id, reusable.id],
      "human-reviewer",
    );
    expect(winner).toMatchObject({ version: 2, parentVersion: 1, content: "reusable" });
    const context = controller.proposalContext();
    expect(JSON.stringify(context)).not.toContain("selectionScore");
    expect(context.pruningTargets).toContain("memory");
    expect(context.evidence.some((item) => item.hypothesis === "test bad-memory")).toBe(true);

    const next = controller.propose("recursive", [edit("skill", "skill", "+generic checklist")]);
    expect(next.harness.parentVersion).toBe(2);
    await controller.evaluate(next.id);
    expect(controller.select([next.id], "human-reviewer").version).toBe(3);
    expect(controller.lineage().map((item) => item.version)).toEqual([1, 2, 3]);
    expect(controller.rollback(1, "release-owner").version).toBe(1);
  });

  it("calibrates noise conservatively and enforces atomic edit budget", () => {
    expect(calibrateNoiseBand([0.48, 0.5, 0.51])).toBeCloseTo(0.03);
    const controller = new RegularizedRsiController(
      initial,
      { publicScore: 0.5, selectionScore: 0.5, policyTokens: 100, safetyPassed: true },
      async () => grades.reusable!,
      { totalRounds: 1, minEditBudget: 1, maxEditBudget: 1 },
    );
    expect(() => controller.propose("too much", [
      edit("one", "prompt", "+one"), edit("two", "memory", "+two"),
    ])).toThrow("edit budget");
  });
});

function edit(id: string, component: AtomicHarnessEdit["component"], sourceDiff: string): AtomicHarnessEdit {
  return {
    id,
    component,
    operation: "update",
    hypothesis: `test ${id}`,
    description: `change ${id}`,
    sourceDiff,
  };
}
