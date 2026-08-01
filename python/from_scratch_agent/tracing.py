"""零依赖、OpenTelemetry-compatible 的 Agent tracing。"""

import json
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Protocol


@dataclass
class SpanRecord:
    trace_id: str
    span_id: str
    name: str
    kind: str
    start_time_unix_nano: str
    end_time_unix_nano: str
    attributes: dict[str, str | int | float | bool] = field(default_factory=dict)
    status: dict[str, str] = field(default_factory=dict)
    parent_span_id: str | None = None


class SpanExporter(Protocol):
    def export(self, span: SpanRecord) -> None:
        """导出一个已经结束的 span。"""


class JsonlTraceExporter:
    """一行写入一个 span；Lock 防止并行工具把两行内容交叉写坏。"""

    def __init__(self, file_path: str | Path) -> None:
        self.file_path = Path(file_path).resolve()
        self._lock = Lock()

    def export(self, span: SpanRecord) -> None:
        # 文件字段与 TypeScript 版保持一致，便于同一个采集器统一处理。
        payload = {
            "traceId": span.trace_id,
            "spanId": span.span_id,
            **(
                {"parentSpanId": span.parent_span_id}
                if span.parent_span_id
                else {}
            ),
            "name": span.name,
            "kind": span.kind,
            "startTimeUnixNano": span.start_time_unix_nano,
            "endTimeUnixNano": span.end_time_unix_nano,
            "attributes": span.attributes,
            "status": span.status,
        }
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._lock:
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            with self.file_path.open("a", encoding="utf-8") as file:
                file.write(line)


class Tracer:
    def __init__(
        self,
        exporter: SpanExporter,
        on_export_error: Callable[[Exception], None] = lambda _error: None,
    ) -> None:
        self.exporter = exporter
        self.on_export_error = on_export_error

    def start_span(
        self,
        name: str,
        parent: "Span | None" = None,
        kind: str = "INTERNAL",
        attributes: dict[str, str | int | float | bool] | None = None,
    ) -> "Span":
        return Span(
            tracer=self,
            name=name,
            trace_id=parent.trace_id if parent else secrets.token_hex(16),
            span_id=secrets.token_hex(8),
            parent_span_id=parent.span_id if parent else None,
            kind=kind,
            attributes=dict(attributes or {}),
            start_time_unix_nano=str(time.time_ns()),
        )

    def finish(self, span: SpanRecord) -> None:
        try:
            self.exporter.export(span)
        except Exception as error:
            # 观测系统故障不应该让模型或工具主流程失败。
            self.on_export_error(error)


@dataclass
class Span:
    tracer: Tracer
    name: str
    trace_id: str
    span_id: str
    parent_span_id: str | None
    kind: str
    attributes: dict[str, str | int | float | bool]
    start_time_unix_nano: str
    _ended: bool = False

    def end(
        self,
        code: str = "OK",
        attributes: dict[str, str | int | float | bool] | None = None,
        error: BaseException | None = None,
    ) -> None:
        if self._ended:
            return
        self._ended = True
        combined = {**self.attributes, **(attributes or {})}
        if error:
            combined["error.type"] = type(error).__name__
            combined["error.message"] = str(error)
        self.tracer.finish(
            SpanRecord(
                trace_id=self.trace_id,
                span_id=self.span_id,
                parent_span_id=self.parent_span_id,
                name=self.name,
                kind=self.kind,
                start_time_unix_nano=self.start_time_unix_nano,
                end_time_unix_nano=str(time.time_ns()),
                attributes=combined,
                status={
                    "code": code,
                    **({"message": str(error)} if error else {}),
                },
            )
        )
