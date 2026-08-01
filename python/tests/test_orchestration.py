"""Stage 4/5 离线测试。"""

import unittest

from from_scratch_agent import (
    Agent,
    AgentEventBus,
    GraphFork,
    InMemoryGraphCheckpointStore,
    StateGraph,
    SubagentScheduler,
    run_subagent,
)


class AnswerModel:
    name = "child"

    def __init__(self, text: str) -> None:
        self.text = text

    def generate(self, system_prompt, messages, tools):
        del system_prompt, messages, tools
        return {
            "role": "assistant",
            "content": [{"type": "text", "text": self.text}],
            "usage": {"input_tokens": 2, "output_tokens": 3},
        }


class OrchestrationTest(unittest.TestCase):
    def test_structured_handoff_event_bus_and_scheduler(self) -> None:
        bus = AgentEventBus()
        events = []
        bus.subscribe(events.append)
        result = run_subagent(
            "research",
            lambda: Agent(AnswerModel("done")),
            "child-1",
            parent_agent_id="parent",
            max_tokens=20,
            event_bus=bus,
        )
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.output, "done")
        self.assertEqual(result.total_tokens, 5)
        self.assertTrue(any(item["event"]["type"] == "agent_end" for item in events))

        scheduler = SubagentScheduler(2)
        results = scheduler.run([
            {"task": "a", "agent_id": "a", "create_agent": lambda: Agent(AnswerModel("A"))},
            {"task": "b", "agent_id": "b", "create_agent": lambda: Agent(AnswerModel("B"))},
        ])
        self.assertEqual([item.output for item in results], ["A", "B"])

    def test_graph_fork_interrupt_checkpoint_and_resume(self) -> None:
        checkpoints = InMemoryGraphCheckpointStore()
        graph = StateGraph(checkpoints=checkpoints)
        graph.add_node("approval", lambda state, context: (
            {"approved": True}
            if context.get("resume_value") == "yes"
            else context["interrupt"]({"question": "approve?"})
        )).add_node("fork", lambda state, context: GraphFork(
            ["left", "right"], "join"
        )).add_node("left", lambda state, context: {"left": state["value"] + 1}
        ).add_node("right", lambda state, context: {"right": state["value"] + 2}
        ).add_node("join", lambda state, context: {
            "value": state["left"] + state["right"]
        }).set_start("approval").add_edge("approval", "fork")

        paused = graph.run({"value": 2}, checkpoint_id="run")
        self.assertEqual(paused.status, "interrupted")
        resumed = graph.run(
            {"value": 0}, checkpoint_id="run", resume=True, resume_value="yes"
        )
        self.assertEqual(resumed.status, "completed")
        self.assertEqual(resumed.state["value"], 7)
        self.assertIsNone(checkpoints.load("run"))


if __name__ == "__main__":
    unittest.main()
