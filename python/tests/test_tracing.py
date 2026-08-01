"""Tracing 离线测试：不发送模型请求，也不依赖 OpenTelemetry SDK。"""

import json
import tempfile
import unittest
from pathlib import Path

from from_scratch_agent import (
    Agent,
    JsonlTraceExporter,
    SpanRecord,
    Tracer,
    calculator_tool,
)
from from_scratch_agent.types import Message, Tool


class Collector:
    def __init__(self) -> None:
        self.records: list[SpanRecord] = []

    def export(self, span: SpanRecord) -> None:
        self.records.append(span)


class ScriptedModel:
    name = "traced-model"

    def __init__(self) -> None:
        self.calls = 0

    def generate(
        self,
        system_prompt: str,
        messages: list[Message],
        tools: list[Tool],
    ) -> Message:
        del system_prompt, messages, tools
        self.calls += 1
        if self.calls == 1:
            return {
                "role": "assistant",
                "content": [{
                    "type": "tool_call",
                    "id": "trace-call",
                    "name": "calculator",
                    "arguments": {
                        "operation": "add",
                        "left": 1,
                        "right": 2,
                    },
                }],
                "usage": {"input_tokens": 10, "output_tokens": 3},
            }
        return {
            "role": "assistant",
            "content": [{"type": "text", "text": "3"}],
            "usage": {"input_tokens": 12, "output_tokens": 1},
        }


class TracingTest(unittest.TestCase):
    def test_agent_creates_parented_model_and_tool_spans(self) -> None:
        collector = Collector()
        agent = Agent(
            ScriptedModel(),
            tools=[calculator_tool],
            tracer=Tracer(collector),
        )

        list(agent.run("1+2"))

        self.assertEqual(
            [record.name for record in collector.records],
            [
                "gen_ai.chat",
                "execute_tool calculator",
                "gen_ai.chat",
                "agent.run",
            ],
        )
        run = collector.records[-1]
        self.assertEqual(run.status["code"], "OK")
        self.assertTrue(
            all(
                record.trace_id == run.trace_id
                and record.parent_span_id == run.span_id
                for record in collector.records[:-1]
            )
        )
        self.assertEqual(
            collector.records[0].attributes["gen_ai.usage.input_tokens"],
            10,
        )

    def test_jsonl_exporter_writes_one_span_per_line(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "traces.jsonl"
            span = Tracer(JsonlTraceExporter(path)).start_span("lesson")
            span.end("OK", {"example": True})

            lines = path.read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(lines), 1)
            record = json.loads(lines[0])
            self.assertEqual(record["name"], "lesson")
            self.assertEqual(record["attributes"], {"example": True})

    def test_exporter_failure_does_not_break_the_agent(self) -> None:
        class BrokenExporter:
            def export(self, span: SpanRecord) -> None:
                del span
                raise RuntimeError("collector offline")

        errors: list[Exception] = []
        agent = Agent(
            ScriptedModel(),
            tools=[calculator_tool],
            tracer=Tracer(BrokenExporter(), errors.append),
        )

        events = list(agent.run("1+2"))

        self.assertTrue(any(event["type"] == "agent_end" for event in events))
        self.assertEqual(len(errors), 4)


if __name__ == "__main__":
    unittest.main()
