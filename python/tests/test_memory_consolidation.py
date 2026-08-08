"""论文启发的 memory consolidation：保留证据、回放门控和回滚。"""

import unittest

from from_scratch_agent import (
    Applicability,
    ConsolidationReplayCase,
    Episode,
    EvidenceLink,
    GovernedMemoryBank,
    apply_governed_memories_to_prompt,
)


def episode(identifier: str, task_id: str, tags: tuple[str, ...], scope: str = "csv-import") -> Episode:
    return Episode(
        id=identifier,
        scope=scope,
        task_id=task_id,
        tags=tags,
        input=f"处理 {identifier}",
        trajectory=f"raw trajectory {identifier}",
        outcome="success",
        created_at="2026-08-01T00:00:00Z",
    )


CASES = [
    ConsolidationReplayCase("new-csv", ("data", "csv"), True, False),
    ConsolidationReplayCase("known-csv", ("data", "csv", "quoted"), True, True),
    ConsolidationReplayCase("json-boundary", ("data", "json"), False, True),
]


class GovernedMemoryTest(unittest.TestCase):
    def test_rejects_overgeneralization_and_keeps_episode_immutable(self) -> None:
        bank = self.seeded_bank()
        candidate = bank.propose(
            "import-rule", "csv-import", "所有数据导入都使用逗号切分。",
            Applicability(("data",)),
            [
                EvidenceLink("csv-1", "support"),
                EvidenceLink("csv-2", "support"),
                EvidenceLink("json-1", "counterexample"),
            ],
            "从成功 CSV 轨迹提炼规则。",
        )
        evaluated = bank.evaluate(
            candidate.id, CASES,
            lambda _candidate, case: case.id != "json-boundary",
        )
        self.assertFalse(evaluated.report.passed)
        self.assertIn("applicability still includes a counterexample", evaluated.report.reasons)
        self.assertIn("replay regression: json-boundary", evaluated.report.reasons)
        with self.assertRaisesRegex(ValueError, "gate"):
            bank.activate(candidate.id, "reviewer")
        self.assertEqual(bank.get_episode("csv-1").trajectory, "raw trajectory csv-1")
        with self.assertRaisesRegex(ValueError, "不可覆盖"):
            bank.retain(episode("csv-1", "changed", ("changed",)))

    def test_activates_bounded_memory_and_rolls_back(self) -> None:
        bank = self.seeded_bank()
        first = bank.propose(*self.good_proposal("仅在 CSV 导入时使用 CSV parser。"))
        evaluated = bank.evaluate(first.id, CASES, self.evaluator)
        self.assertTrue(evaluated.report.passed)
        bank.activate(first.id, "human-reviewer")
        active = bank.active(("data", "csv"))
        self.assertEqual(active[0].source_episode_ids, ("csv-1", "csv-2", "json-1"))
        self.assertEqual(bank.active(("data", "json")), [])
        self.assertIn('sources="csv-1,csv-2,json-1"', apply_governed_memories_to_prompt("base", active))

        second = bank.propose(*self.good_proposal("CSV 导入应使用支持引号字段的 parser。"))
        bank.evaluate(second.id, CASES, self.evaluator)
        bank.activate(second.id, "human-reviewer")
        self.assertEqual(bank.active(("data", "csv"))[0].version, 2)
        bank.rollback("import-rule", 1, "release-owner")
        self.assertEqual(bank.active(("data", "csv"))[0].version, 1)
        self.assertEqual(
            [release.action for release in bank.release_history()],
            ["activate", "activate", "rollback"],
        )

    @staticmethod
    def evaluator(_candidate, case: ConsolidationReplayCase) -> bool:
        return True if case.id == "new-csv" else case.baseline_passed

    @staticmethod
    def seeded_bank() -> GovernedMemoryBank:
        bank = GovernedMemoryBank()
        bank.retain(episode("csv-1", "task-a", ("data", "csv")))
        bank.retain(episode("csv-2", "task-b", ("data", "csv", "quoted")))
        bank.retain(episode("json-1", "task-c", ("data", "json"), "json-import"))
        return bank

    @staticmethod
    def good_proposal(lesson: str):
        return (
            "import-rule",
            "csv-import",
            lesson,
            Applicability(("data", "csv"), ("json",)),
            [
                EvidenceLink("csv-1", "support"),
                EvidenceLink("csv-2", "support"),
                EvidenceLink("json-1", "counterexample"),
            ],
            "保留 CSV 的适用条件和 JSON 反例。",
        )


if __name__ == "__main__":
    unittest.main()
