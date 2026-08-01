"""Stage 6 的离线回归测试。"""

import unittest

from from_scratch_agent import (
    ArtifactVersion,
    EvalCase,
    EvalSampleResult,
    EvolutionController,
    InMemoryArtifactStore,
)


class EvolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = InMemoryArtifactStore()
        self.baseline = ArtifactVersion(
            "assistant-prompt", "prompt", 1, "old prompt", "2026-01-01T00:00:00Z"
        )
        self.store.put(self.baseline)
        self.store.activate("assistant-prompt", 1)
        self.dataset = [
            EvalCase("public", "公开问题", "eval"),
            EvalCase("secret", "隐藏问题", "holdout"),
        ]

    def test_approve_publish_and_rollback(self) -> None:
        controller = EvolutionController(
            self.store, self.dataset,
            lambda artifact, case: EvalSampleResult(
                "answer", artifact.version == 2, True, 10, 0.01, 20
            ),
        )
        candidate = controller.propose(
            "assistant-prompt", "prompt", "better prompt", "fix failure", ["trace-1"]
        )
        stale = controller.propose(
            "assistant-prompt", "prompt", "another v1 proposal", "parallel", ["trace-3"]
        )
        with self.assertRaisesRegex(ValueError, "批准"):
            controller.publish(candidate.id, "owner")
        evaluated = controller.evaluate(candidate.id)
        self.assertTrue(evaluated.report.gate_passed)
        controller.approve(candidate.id, "human")
        controller.publish(candidate.id, "owner")
        self.assertEqual(self.store.get_active("assistant-prompt").version, 2)
        monitoring = controller.monitor_active("assistant-prompt")
        self.assertTrue(monitoring.report.gate_passed)
        self.assertEqual(len(controller.monitoring_history()), 1)
        controller.evaluate(stale.id)
        controller.approve(stale.id, "human")
        with self.assertRaisesRegex(ValueError, "已变化"):
            controller.publish(stale.id, "owner")
        controller.rollback("assistant-prompt", 1, "on-call")
        self.assertEqual(self.store.get_active("assistant-prompt").version, 1)
        self.assertEqual(
            [record.action for record in controller.release_history()],
            ["publish", "rollback"],
        )

    def test_holdout_safety_and_immutable_version_block_release(self) -> None:
        controller = EvolutionController(
            self.store, self.dataset,
            lambda artifact, case: EvalSampleResult(
                "answer",
                artifact.version == 1 or case.split == "eval",
                artifact.version == 1,
                10 if artifact.version == 1 else 30,
                0,
                10,
            ),
        )
        candidate = controller.propose(
            "assistant-prompt", "prompt", "overfit", "fix public", ["trace-2"]
        )
        evaluated = controller.evaluate(candidate.id)
        self.assertFalse(evaluated.report.gate_passed)
        self.assertIn("holdout pass rate below minimum", evaluated.report.gate_reasons)
        self.assertIn("safety check failed", evaluated.report.gate_reasons)
        with self.assertRaisesRegex(ValueError, "release gate"):
            controller.approve(candidate.id, "human")
        with self.assertRaisesRegex(ValueError, "已存在"):
            self.store.put(self.baseline)


if __name__ == "__main__":
    unittest.main()
