import { describe, expect, it } from "vitest";
import {
  GovernedMemoryBank,
  applyGovernedMemoriesToPrompt,
  type ConsolidationReplayCase,
  type Episode,
} from "../src/memory-consolidation/index.js";

const episode = (
  id: string,
  taskId: string,
  tags: string[],
  scope = "csv-import",
): Episode => ({
  id, taskId, tags, scope,
  input: `处理 ${id}`,
  trajectory: `raw trajectory ${id}`,
  outcome: "success",
  createdAt: "2026-08-01T00:00:00Z",
});

const replayCases: ConsolidationReplayCase[] = [
  { id: "new-csv", tags: ["data", "csv"], shouldApply: true, baselinePassed: false },
  { id: "known-csv", tags: ["data", "csv", "quoted"], shouldApply: true, baselinePassed: true },
  { id: "json-boundary", tags: ["data", "json"], shouldApply: false, baselinePassed: true },
];

describe("paper-inspired governed memory consolidation", () => {
  it("keeps raw episodes immutable and rejects an overgeneralized abstraction", async () => {
    const bank = seededBank();
    const bad = bank.propose({
      memoryId: "import-rule", scope: "csv-import",
      lesson: "所有数据导入都使用逗号切分。",
      applicability: { allTags: ["data"], noneTags: [] },
      evidence: [
        { episodeId: "csv-1", relation: "support" },
        { episodeId: "csv-2", relation: "support" },
        { episodeId: "json-1", relation: "counterexample" },
      ],
      rationale: "从成功 CSV 轨迹提炼规则。",
    });
    const evaluated = await bank.evaluate(bad.id, replayCases, (_candidate, testCase) =>
      testCase.id !== "json-boundary"
    );
    expect(evaluated.report?.passed).toBe(false);
    expect(evaluated.report?.reasons).toEqual(expect.arrayContaining([
      "applicability still includes a counterexample",
      "applicability mismatch: json-boundary",
      "replay regression: json-boundary",
    ]));
    expect(() => bank.activate(bad.id, "reviewer")).toThrow("passed");
    expect(bank.getEpisode("csv-1")?.trajectory).toBe("raw trajectory csv-1");
    expect(() => bank.retain({ ...episode("csv-1", "task-a", ["changed"]), trajectory: "overwrite" }))
      .toThrow("immutable");
  });

  it("activates a bounded lesson with source citations and supports rollback", async () => {
    const bank = seededBank();
    const first = bank.propose(goodProposal("仅在 CSV 导入时使用 CSV parser。"));
    const evaluated = await bank.evaluate(first.id, replayCases, (_candidate, testCase) =>
      testCase.id === "new-csv" ? true : testCase.baselinePassed
    );
    expect(evaluated.report).toMatchObject({
      passed: true, supportingEpisodes: 2, distinctSupportingTasks: 2, counterexamples: 1,
    });
    bank.activate(first.id, "human-reviewer");
    const active = bank.active(["data", "csv"]);
    expect(active[0]?.sourceEpisodeIds).toEqual(["csv-1", "csv-2", "json-1"]);
    expect(bank.active(["data", "json"])).toEqual([]);
    expect(applyGovernedMemoriesToPrompt("base", active)).toContain('sources="csv-1,csv-2,json-1"');

    const second = bank.propose(goodProposal("CSV 导入应使用支持引号字段的 parser。"));
    await bank.evaluate(second.id, replayCases, (_candidate, testCase) =>
      testCase.id === "new-csv" ? true : testCase.baselinePassed
    );
    bank.activate(second.id, "human-reviewer");
    expect(bank.active(["data", "csv"])[0]?.version).toBe(2);
    bank.rollback("import-rule", 1, "release-owner");
    expect(bank.active(["data", "csv"])[0]?.version).toBe(1);
    expect(bank.releaseHistory().map((release) => release.action)).toEqual([
      "activate", "activate", "rollback",
    ]);
  });
});

function seededBank(): GovernedMemoryBank {
  const bank = new GovernedMemoryBank();
  bank.retain(episode("csv-1", "task-a", ["data", "csv"]));
  bank.retain(episode("csv-2", "task-b", ["data", "csv", "quoted"]));
  bank.retain(episode("json-1", "task-c", ["data", "json"], "json-import"));
  return bank;
}

function goodProposal(lesson: string) {
  return {
    memoryId: "import-rule",
    scope: "csv-import",
    lesson,
    applicability: { allTags: ["data", "csv"], noneTags: ["json"] },
    evidence: [
      { episodeId: "csv-1", relation: "support" as const },
      { episodeId: "csv-2", relation: "support" as const },
      { episodeId: "json-1", relation: "counterexample" as const },
    ],
    rationale: "保留 CSV 的适用条件和 JSON 反例。",
  };
}
