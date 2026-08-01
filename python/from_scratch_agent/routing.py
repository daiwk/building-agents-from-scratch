"""显式模型路由、fallback，以及 generator/judge 隔离指标。"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Callable
from .types import ModelProvider


@dataclass
class ModelRoute:
    name: str
    model: ModelProvider
    when: Callable[[dict], bool] | None = None


class ModelRouter:
    def __init__(self, routes: list[ModelRoute]) -> None:
        if not routes:
            raise ValueError("至少需要一个 model route")
        if len({route.name for route in routes}) != len(routes):
            raise ValueError("model route 名称不能重复")
        self.routes = routes
        self.metrics: dict[tuple[str, str], dict] = {}

    def generate(self, system_prompt: str, messages: list[dict], tools: list,
                 task: str, role: str = "generator",
                 preferred_model: str | None = None) -> dict:
        context = {"task": task, "role": role, "preferred_model": preferred_model}
        candidates = [route for route in self.routes
                      if route.when is None or route.when(context)]
        if preferred_model:
            preferred = next(
                (route for route in self.routes if route.name == preferred_model), None
            )
            if preferred is None:
                raise ValueError(f"未知 preferred model：{preferred_model}")
            candidates = [preferred, *[route for route in candidates if route is not preferred]]
        failures = []
        for route in candidates:
            metric = self._metric(role, route.name)
            metric["requests"] += 1
            try:
                message = route.model.generate(system_prompt, messages, tools)
                metric["successes"] += 1
                usage = message.get("usage", {})
                metric["input_tokens"] += usage.get("input", 0)
                metric["output_tokens"] += usage.get("output", 0)
                return {**message, "routed_model": route.name}
            except Exception as error:
                metric["failures"] += 1
                failures.append(f"{route.name}: {error}")
        raise RuntimeError("所有 routed models 均失败：" + " | ".join(failures))

    def snapshot_metrics(self) -> list[dict]:
        return [dict(metric) for metric in self.metrics.values()]

    def _metric(self, role: str, model: str) -> dict:
        key = (role, model)
        if key not in self.metrics:
            self.metrics[key] = {
                "role": role, "model": model, "requests": 0, "successes": 0,
                "failures": 0, "input_tokens": 0, "output_tokens": 0,
            }
        return self.metrics[key]
