"""只有工作流需要分支、恢复或审批时才使用的独立状态图。"""

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class GraphFork:
    branches: list[str]
    join: str


@dataclass
class GraphResult:
    status: str
    state: dict[str, Any]
    steps: int
    value: Any = None


class GraphInterrupt(Exception):
    def __init__(self, value: Any) -> None:
        self.value = value


class InMemoryGraphCheckpointStore:
    def __init__(self) -> None:
        self.checkpoints: dict[str, dict] = {}

    def load(self, checkpoint_id: str) -> dict | None:
        value = self.checkpoints.get(checkpoint_id)
        return deepcopy(value) if value else None

    def save(self, checkpoint_id: str, checkpoint: dict) -> None:
        self.checkpoints[checkpoint_id] = deepcopy(checkpoint)

    def clear(self, checkpoint_id: str) -> None:
        self.checkpoints.pop(checkpoint_id, None)


class StateGraph:
    def __init__(self, reducer=None, checkpoints=None) -> None:
        self.nodes: dict[str, Callable] = {}
        self.edges: dict[str, list[tuple[str, Callable | None]]] = {}
        self.start: str | None = None
        self.reducer = reducer or self._default_reducer
        self.checkpoints = checkpoints

    def add_node(self, name: str, node: Callable) -> "StateGraph":
        if name in self.nodes:
            raise ValueError(f"Graph node 已存在：{name}")
        self.nodes[name] = node
        return self

    def add_edge(self, source: str, target: str, condition=None) -> "StateGraph":
        self.edges.setdefault(source, []).append((target, condition))
        return self

    def set_start(self, name: str) -> "StateGraph":
        self.start = name
        return self

    def run(self, initial_state: dict, checkpoint_id: str | None = None,
            resume: bool = False, resume_value=None, max_steps: int = 100) -> GraphResult:
        if max_steps <= 0:
            raise ValueError("max_steps 必须大于 0")
        saved = self.checkpoints.load(checkpoint_id) if (
            resume and checkpoint_id and self.checkpoints
        ) else None
        state = deepcopy(saved["state"] if saved else initial_state)
        current = saved["next_node"] if saved else self.start
        steps = saved["steps"] if saved else 0
        pending_resume_value = resume_value
        if not current:
            raise ValueError("Graph start node 未配置")
        while current:
            if steps >= max_steps:
                raise RuntimeError(f"Graph 超过 {max_steps} steps")
            node = self.nodes.get(current)
            if not node:
                raise ValueError(f"未知 Graph node：{current}")
            try:
                output = node(deepcopy(state), {
                    "resume_value": pending_resume_value,
                    "interrupt": lambda value: self._interrupt(value),
                })
                # 恢复值只交给被恢复的节点，不继续传给后续节点。
                pending_resume_value = None
                steps += 1
                if isinstance(output, GraphFork):
                    branch_nodes = [self._require_node(name) for name in output.branches]
                    # 每个分支读取独立 state 副本；future 按创建顺序取值，
                    # 所以 reducer 即使在并行执行后仍然得到确定的合并顺序。
                    with ThreadPoolExecutor(max_workers=max(1, len(branch_nodes))) as executor:
                        futures = [
                            executor.submit(node, deepcopy(state), {
                                "resume_value": None,
                                "interrupt": self._reject_branch_interrupt,
                            })
                            for node in branch_nodes
                        ]
                        updates = [future.result() or {} for future in futures]
                    state = self.reducer(state, updates)
                    current = output.join
                else:
                    if output:
                        state = self.reducer(state, [output])
                    current = self._next(current, state)
                self._save(checkpoint_id, state, current or "", steps)
            except GraphInterrupt as interrupt:
                self._save(checkpoint_id, state, current, steps, interrupt.value)
                return GraphResult("interrupted", state, steps, interrupt.value)
        if checkpoint_id and self.checkpoints:
            self.checkpoints.clear(checkpoint_id)
        return GraphResult("completed", state, steps)

    def _next(self, source: str, state: dict) -> str | None:
        for target, condition in self.edges.get(source, []):
            if condition is None or condition(state):
                return target
        return None

    def _require_node(self, name: str) -> Callable:
        node = self.nodes.get(name)
        if not node:
            raise ValueError(f"未知 Graph node：{name}")
        return node

    def _save(self, checkpoint_id, state, next_node, steps, value=None) -> None:
        if checkpoint_id and self.checkpoints:
            self.checkpoints.save(checkpoint_id, {
                "state": state, "next_node": next_node, "steps": steps,
                "interrupt_value": value,
            })

    @staticmethod
    def _interrupt(value):
        raise GraphInterrupt(value)

    @staticmethod
    def _reject_branch_interrupt(_value):
        raise RuntimeError("并行 branch 不能直接 interrupt；请在 join node 暂停")

    @staticmethod
    def _default_reducer(state, updates):
        result = deepcopy(state)
        for update in updates:
            result.update(update)
        return result
