import json
import tempfile
import time
import unittest
from pathlib import Path

from from_scratch_agent import (
    DurableTaskRunner,
    McpClient,
    ModelRoute,
    ModelRouter,
    SqliteDurableTaskStore,
    SqliteGraphCheckpointStore,
    StateGraph,
    generate_structured,
)


def message(text, input_tokens=1, output_tokens=1):
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "stop",
        "usage": {"input": input_tokens, "output": output_tokens},
    }


class FakeTransport:
    def __init__(self):
        self.calls = []

    def request(self, method, _params, _request_id=None):
        self.calls.append(method)
        if method == "initialize":
            return {}
        if method == "tools/list":
            return {"tools": [
                {"name": "lookup", "inputSchema": {"type": "object"}},
                {"name": "admin", "inputSchema": {"type": "object"}},
            ]}
        return {"content": "ok", "token": "do-not-leak"}

    def notify(self, _method, _params=None):
        return None

    def close(self):
        return None


class SequenceModel:
    name = "sequence"

    def __init__(self, outputs):
        self.outputs = list(outputs)

    def generate(self, _system_prompt, _messages, _tools):
        value = self.outputs.pop(0)
        if isinstance(value, Exception):
            raise value
        return message(value, 3, 2)


class Stage1012Test(unittest.TestCase):
    def test_mcp_allowlist_and_redaction(self):
        transport = FakeTransport()
        registry = McpClient("docs", transport, ["lookup"]).create_registry()
        self.assertEqual([tool.name for tool in registry.list()], ["docs__lookup"])
        result = json.loads(registry.list()[0].execute({}))
        self.assertEqual(result["token"], "[REDACTED]")
        self.assertEqual(
            transport.calls, ["initialize", "tools/list", "tools/call"]
        )

    def test_mcp_timeout_sends_cancellation(self):
        class SlowTransport:
            def __init__(self):
                self.notifications = []

            def request(self, _method, _params, _request_id=None):
                time.sleep(0.1)

            def notify(self, method, params=None):
                self.notifications.append((method, params))

            def close(self):
                pass

        transport = SlowTransport()
        with self.assertRaises(TimeoutError):
            McpClient("slow", transport, [], 0.001).list_tools()
        self.assertEqual(transport.notifications[0][0], "notifications/cancelled")
        self.assertIn("requestId", transport.notifications[0][1])

    def test_structured_repair_and_model_fallback_metrics(self):
        result = generate_structured(
            SequenceModel(["broken", '```json{"answer":"ok"}```']),
            "test", [], {
                "type": "object",
                "properties": {"answer": {"type": "string"}},
                "required": ["answer"],
                "additionalProperties": False,
            },
        )
        self.assertEqual(result.value, {"answer": "ok"})
        self.assertEqual(result.repair_attempts, 1)

        router = ModelRouter([
            ModelRoute("primary", SequenceModel([RuntimeError("offline")])),
            ModelRoute("fallback", SequenceModel(["ok", "judge"])),
        ])
        routed = router.generate("test", [], [], "write", "generator")
        self.assertEqual(routed["routed_model"], "fallback")
        router.generate("test", [], [], "score", "judge", "fallback")
        self.assertEqual(
            [(item["role"], item["model"]) for item in router.snapshot_metrics()],
            [("generator", "primary"), ("generator", "fallback"),
             ("judge", "fallback")],
        )

    def test_sqlite_checkpoint_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.sqlite"

            def make_graph(store):
                graph = StateGraph(checkpoints=store)

                def approval(_state, context):
                    if context["resume_value"] is not True:
                        context["interrupt"]({"question": "approve?"})
                    return {"approved": True}

                return (
                    graph.add_node("approval", approval)
                    .add_node("finish", lambda _state, _context: {"done": True})
                    .add_edge("approval", "finish")
                    .set_start("approval")
                )

            first = SqliteGraphCheckpointStore(path)
            self.assertEqual(
                make_graph(first).run({}, checkpoint_id="run-1").status,
                "interrupted",
            )
            first.close()
            second = SqliteGraphCheckpointStore(path)
            resumed = make_graph(second).run(
                {}, checkpoint_id="run-1", resume=True, resume_value=True
            )
            self.assertEqual(resumed.status, "completed")
            self.assertEqual(resumed.state, {"approved": True, "done": True})
            second.close()

    def test_durable_task_and_events_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tasks.sqlite"
            first = SqliteDurableTaskStore(path)
            first.enqueue("double", {"value": 4}, "task-1")
            first.enqueue("double", {"value": 4}, "task-1")
            first.close()

            second = SqliteDurableTaskStore(path)

            def double(payload, context):
                context["append_event"]("progress", {"percent": 50})
                return {"value": payload["value"] * 2}

            task = DurableTaskRunner(
                second, "worker-1", {"double": double}
            ).run_next()
            self.assertEqual(task.status, "completed")
            self.assertEqual(task.result, {"value": 8})
            self.assertEqual(
                [event.type for event in second.events("task-1")],
                ["enqueued", "claimed", "progress", "completed"],
            )
            second.close()

    def test_expired_worker_lease_is_recovered(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SqliteDurableTaskStore(Path(directory) / "lease.sqlite")
            store.enqueue("work", {}, "leased-task")
            self.assertEqual(store.claim("worker-a", 1).status, "running")
            time.sleep(0.005)
            self.assertEqual(store.claim("worker-b").worker_id, "worker-b")
            self.assertEqual(
                [event.type for event in store.events("leased-task")],
                ["enqueued", "claimed", "lease_expired", "claimed"],
            )
            store.close()


if __name__ == "__main__":
    unittest.main()
