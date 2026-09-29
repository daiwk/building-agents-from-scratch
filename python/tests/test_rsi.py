"""Stage 17 regularized RSI 的离线确定性测试。"""

import unittest
from dataclasses import asdict

from from_scratch_agent import (
    AtomicHarnessEdit,
    HarnessGrade,
    HarnessVersion,
    RegularizedRsiController,
    RsiPolicy,
    calibrate_noise_band,
)


GRADES = {
    "expensive": HarnessGrade(0.62, 0.60, 200, True),
    "negative": HarnessGrade(0.40, 0.49, 100, True),
    "reusable": HarnessGrade(0.59, 0.58, 105, True),
    "recursive": HarnessGrade(0.64, 0.63, 106, True),
}


def edit(identifier: str, component: str, source_diff: str) -> AtomicHarnessEdit:
    return AtomicHarnessEdit(
        identifier, component, "update", f"test {identifier}",
        f"change {identifier}", source_diff,
    )


class RegularizedRsiTest(unittest.TestCase):
    def setUp(self) -> None:
        initial = HarnessVersion(
            "research-agent", 1, "base harness", "2026-09-01T00:00:00Z"
        )
        self.calls = 0

        def grader(harness: HarnessVersion) -> HarnessGrade:
            self.calls += 1
            return GRADES[harness.content]

        self.controller = RegularizedRsiController(
            initial,
            HarnessGrade(0.5, 0.5, 100, True),
            grader,
            RsiPolicy(total_rounds=4, min_edit_budget=1, max_edit_budget=3),
            ("secret-case-42",),
        )

    def test_recursive_lineage_and_regularized_selection(self) -> None:
        self.assertEqual(self.controller.edit_budget(0), 3)
        self.assertEqual(self.controller.edit_budget(4), 1)
        leaked = self.controller.propose(
            "leak", [edit("leak", "prompt", "mention secret-case-42")]
        )
        self.assertEqual(leaked.status, "screened_out")
        with self.assertRaisesRegex(ValueError, "Screened"):
            self.controller.evaluate(leaked.id)
        self.assertEqual(self.calls, 0)

        expensive = self.controller.propose(
            "expensive", [edit("big", "control_flow", "+more loops")]
        )
        negative = self.controller.propose(
            "negative", [edit("bad-memory", "memory", "+unused cache")]
        )
        reusable = self.controller.propose(
            "reusable", [edit("retry", "config", "+bounded retry")]
        )
        expensive_result = self.controller.evaluate(expensive.id)
        self.controller.evaluate(negative.id)
        reusable_result = self.controller.evaluate(reusable.id)
        self.assertNotIn("selection_score", str(asdict(reusable_result)))
        self.assertIn(
            "cost growth is not justified by score gain",
            expensive_result.selection.reasons,
        )
        self.assertTrue(reusable_result.selection.admissible)
        with self.assertRaisesRegex(ValueError, "全部 candidates"):
            self.controller.select([reusable.id], "human-reviewer")

        winner = self.controller.select(
            [leaked.id, expensive.id, negative.id, reusable.id], "human-reviewer"
        )
        self.assertEqual((winner.version, winner.parent_version), (2, 1))
        context = self.controller.proposal_context()
        self.assertNotIn("selection_score", str(asdict(context)))
        self.assertIn("memory", context.pruning_targets)

        next_candidate = self.controller.propose(
            "recursive", [edit("skill", "skill", "+generic checklist")]
        )
        self.assertEqual(next_candidate.harness.parent_version, 2)
        self.controller.evaluate(next_candidate.id)
        self.assertEqual(
            self.controller.select([next_candidate.id], "human-reviewer").version, 3
        )
        self.assertEqual([item.version for item in self.controller.lineage()], [1, 2, 3])
        self.assertEqual(self.controller.rollback(1, "release-owner").version, 1)

    def test_noise_calibration_and_atomic_budget(self) -> None:
        self.assertAlmostEqual(calibrate_noise_band([0.48, 0.5, 0.51]), 0.03)
        controller = RegularizedRsiController(
            HarnessVersion("agent", 1, "base", "2026-09-01T00:00:00Z"),
            HarnessGrade(0.5, 0.5, 10, True),
            lambda _harness: HarnessGrade(0.6, 0.6, 10, True),
            RsiPolicy(total_rounds=1, min_edit_budget=1, max_edit_budget=1),
        )
        with self.assertRaisesRegex(ValueError, "edit budget"):
            controller.propose("too much", [
                edit("one", "prompt", "+one"),
                edit("two", "memory", "+two"),
            ])


if __name__ == "__main__":
    unittest.main()
