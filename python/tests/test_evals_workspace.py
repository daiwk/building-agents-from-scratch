import tempfile
import unittest
from pathlib import Path

from from_scratch_agent import (
    ArtifactVersion,
    EvalCase,
    JsonlEvalDatasetStore,
    ReplayEvalCase,
    TraceReplayEvaluator,
    create_workspace_toolkit,
)


EVENTS = [{"type": "agentStart"}, {"type": "agentEnd"}]


class EvalWorkspaceTest(unittest.TestCase):
    def test_jsonl_replay(self):
        run = lambda version, output: {
            "artifactVersion": version, "output": output, "safetyPassed": True,
            "tokens": 1, "cost": 0, "latencyMs": 1, "events": EVENTS,
        }
        dataset = [
            ReplayEvalCase("public", "q", "eval", "good", "equals", {
                "1": run(1, "bad"), "2": run(2, "good"),
            }),
            ReplayEvalCase("hidden", "q", "holdout", "good", "equals", {
                "1": run(1, "bad"), "2": run(2, "good"),
            }),
        ]
        with tempfile.TemporaryDirectory() as directory:
            store = JsonlEvalDatasetStore(Path(directory) / "dataset.jsonl")
            store.save(dataset)
            loaded = store.load()
            evaluator = TraceReplayEvaluator(loaded)
            result = evaluator(
                ArtifactVersion("p", "prompt", 2, "v2", "now"),
                EvalCase("public", "q", "eval", "good"),
            )
            self.assertTrue(result.passed)

    def test_workspace_boundary_and_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "notes.txt").write_text("hello\n" + "x" * 100, encoding="utf-8")
            kit = create_workspace_toolkit(root, max_inline_characters=20)
            tools = {tool.name: tool for tool in kit.registry.list()}
            self.assertNotIn("write_file", tools)
            output = tools["read_file"].execute({"path": "notes.txt"})
            self.assertIn("artifact-1", output)
            self.assertIn("hello", kit.artifacts.get("artifact-1").content)
            self.assertIn("hello", tools["read_artifact"].execute({
                "id": "artifact-1", "offset": 0, "limit": 5,
            }))
            with self.assertRaisesRegex(ValueError, "escapes"):
                tools["read_file"].execute({"path": "../outside.txt"})


if __name__ == "__main__":
    unittest.main()
