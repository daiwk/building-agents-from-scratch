"""生成教学 Notebook。

不要手工编辑 ipynb 的 JSON；修改本脚本后重新运行即可。
"""

from pathlib import Path

import nbformat as nbf


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "notebooks" / "agent_from_scratch.ipynb"


def markdown(text: str):
    return nbf.v4.new_markdown_cell(text.strip())


def code(source: str):
    return nbf.v4.new_code_cell(source.strip())


notebook = nbf.v4.new_notebook(
    metadata={
        "kernelspec": {
            "display_name": "Python 3",
            "language": "python",
            "name": "python3",
        },
        "language_info": {"name": "python", "version": "3.11"},
    }
)

notebook.cells = [
    markdown(
        """
# 从零看懂一个 Agent Loop

## Goal

这个 Notebook 面向第一次接触 Agent 的读者。运行完后，你会亲眼看到：

```text
用户消息 → 模型请求工具 → Python 执行工具 → 结果写回历史 → 模型最终回答
```

默认使用**脚本化假模型**，不需要 API Key，也不会消耗 MiniMax 配额。每个单元格只做一件事，
适合逐格修改和观察。
"""
    ),
    markdown(
        """
## Setup

### 1. 找到项目里的 Python 包

这段代码只处理 import 路径。它不会安装依赖，也不会访问网络。
"""
    ),
    code(
        """
from pathlib import Path
import sys

project_root = Path.cwd()
if not (project_root / "python").exists():
    project_root = project_root.parent
python_source = project_root / "python"
if str(python_source) not in sys.path:
    sys.path.insert(0, str(python_source))

print("项目目录：", project_root)
"""
    ),
    markdown(
        """
### 2. 导入 Agent 和工具

真正的循环在 `python/from_scratch_agent/agent.py`，这里只有普通 Python：
列表保存消息、`for` 控制轮次、`yield` 发出事件。
"""
    ),
    code(
        """
from from_scratch_agent import Agent, calculator_tool

print("工具名：", calculator_tool.name)
print("工具说明：", calculator_tool.description)
"""
    ),
    markdown(
        """
## Steps

### 3. 创建一个可预测的假模型

真实模型的输出不完全确定，不适合第一次调试。下面的模型固定返回两条消息：

1. 第一轮请求 `calculator`；
2. 收到工具结果后回答“答案是 42”。
"""
    ),
    code(
        """
class ScriptedModel:
    name = "scripted"

    def __init__(self):
        self.replies = [
            {
                "role": "assistant",
                "content": [{
                    "type": "tool_call",
                    "id": "call-1",
                    "name": "calculator",
                    "arguments": {
                        "operation": "multiply",
                        "left": 6,
                        "right": 7,
                    },
                }],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "答案是 42"}],
            },
        ]
        self.calls = 0

    def generate(self, system_prompt, messages, tools):
        reply = self.replies[self.calls]
        self.calls += 1
        return reply

model = ScriptedModel()
"""
    ),
    markdown(
        """
### 4. 运行 Agent，并收集每一步事件

尝试把 `6 × 7` 改成别的数字，同时修改上一个单元格中的工具参数。
"""
    ),
    code(
        """
agent = Agent(
    model=model,
    tools=[calculator_tool],
    system_prompt="你是一个可靠的计算助手。",
)

events = list(agent.run("6 × 7 是多少？"))
for index, event in enumerate(events, start=1):
    print(f"{index:02d}. {event['type']}")
"""
    ),
    markdown(
        """
### 5. 展开关键事件

`tool_start` 是模型的请求；`tool_end` 才是 Python 真正执行后的结果。
"""
    ),
    code(
        """
from pprint import pprint

for event in events:
    if event["type"] in {"tool_start", "tool_end", "text"}:
        print("\\nEVENT:", event["type"])
        pprint(event)
"""
    ),
    markdown(
        """
### 6. 直接查看短期记忆

下面四条消息正好形成闭环。注意第三条 `tool` 消息如何把 `42` 交回模型。
"""
    ),
    code(
        """
for index, message in enumerate(agent.context.messages, start=1):
    print(f"{index}. role={message['role']}")
    pprint(message)
"""
    ),
    markdown(
        """
## Checks

这些断言是最小 Agent 必须满足的不变量。修改代码时如果破坏了反馈环，它们会立即报错。
"""
    ),
    code(
        """
assert model.calls == 2, "有工具调用时应该调用模型两轮"
assert agent.context.messages[2]["role"] == "tool"
assert agent.context.messages[2]["content"] == "42"
assert events[-1]["type"] == "agent_end"
print("✓ 所有检查通过：Agent loop 完整闭合")
"""
    ),
    markdown(
        """
## Stage 2/3：Memory 与 Skills

下面继续用离线组件观察三层 memory 和版本化 Skill。真实 tokenizer、摘要模型或模型路由
都通过小接口注入，不会藏进 Agent loop。
"""
    ),
    code(
        """
from from_scratch_agent import (
    ExtractiveSummaryProvider,
    InMemoryMemoryIndex,
    MemoryRecord,
    SkillCatalog,
    TokenContextBuilder,
)
from from_scratch_agent.skills import parse_skill_markdown

class CharacterCounter:
    def count(self, text):
        return len(text)

token_context = TokenContextBuilder(
    max_tokens=80,
    token_counter=CharacterCounter(),
    summarizer=ExtractiveSummaryProvider(),
)

memory_index = InMemoryMemoryIndex()
memory_index.upsert(MemoryRecord("preference", "semantic", "用户喜欢中文回答"))
memory_index.upsert(MemoryRecord("release-rule", "procedural", "发布前必须运行测试"))
print([(item.kind, item.content) for item in memory_index.search("如何用中文回答")])
"""
    ),
    code(
        """
base_skill = parse_skill_markdown(
    "---\\nname: base\\ndescription: 基础格式\\nversion: 1.0.0\\n---\\n保持结构清晰。",
    "base/SKILL.md",
)
report_skill = parse_skill_markdown(
    "---\\nname: report\\ndescription: 生成分析报告\\ndependencies: base\\ntags: 报告, analysis\\n---\\n先给结论再给证据。",
    "report/SKILL.md",
)
skill_catalog = SkillCatalog().register_many([base_skill, report_skill])
print("依赖顺序：", [skill.name for skill in skill_catalog.select(["report"])])
print("自动发现：", [skill.name for skill in skill_catalog.discover("写分析报告")])
"""
    ),
    markdown(
        """
## Stage 4/5：Sub-agent 与 Graph

Sub-agent 返回结构化 handoff；Graph 只在需要条件路径、checkpoint 或审批时使用。
"""
    ),
    code(
        """
from from_scratch_agent import (
    InMemoryGraphCheckpointStore,
    StateGraph,
    run_subagent,
)

class AnswerModel:
    name = "child"
    def generate(self, system_prompt, messages, tools):
        return {
            "role": "assistant",
            "content": [{"type": "text", "text": "子任务完成"}],
            "usage": {"input_tokens": 2, "output_tokens": 3},
        }

handoff = run_subagent(
    "检查报告",
    lambda: Agent(AnswerModel()),
    agent_id="reviewer",
    max_depth=2,
    max_turns=2,
    max_tokens=20,
)
print(handoff)
"""
    ),
    code(
        """
checkpoints = InMemoryGraphCheckpointStore()
graph = StateGraph(checkpoints=checkpoints)
graph.add_node("approval", lambda state, context: (
    {"approved": True}
    if context.get("resume_value") == "yes"
    else context["interrupt"]("需要人工审批")
)).set_start("approval")

paused = graph.run({"draft": "v1"}, checkpoint_id="notebook-run")
print("暂停：", paused)
resumed = graph.run(
    {}, checkpoint_id="notebook-run", resume=True, resume_value="yes"
)
print("恢复：", resumed)
"""
    ),
    markdown(
        """
## Stage 6：受控 Self-evolve

模型不能直接改线上 prompt。下面用固定的 eval/holdout、二元评分和人工 gate 演示完整闭环；
假 evaluator 不调用网络，因此每次运行结果一致。
"""
    ),
    code(
        """
from from_scratch_agent import (
    ArtifactVersion,
    EvalCase,
    EvalSampleResult,
    EvolutionController,
    InMemoryArtifactStore,
)

artifact_store = InMemoryArtifactStore()
artifact_store.put(ArtifactVersion(
    "assistant-prompt", "prompt", 1, "旧 prompt", "2026-01-01T00:00:00Z"
))
artifact_store.activate("assistant-prompt", 1)

eval_dataset = [
    EvalCase("public-1", "公开问题", "eval"),
    EvalCase("hidden-1", "隐藏问题", "holdout"),
]

def offline_evaluator(artifact, test_case):
    passed = artifact.version == 2
    return EvalSampleResult(
        output="正确回答" if passed else "失败回答",
        passed=passed,
        safety_passed=True,
        tokens=10,
        cost=0.01,
        latency_ms=20,
    )

evolution = EvolutionController(
    artifact_store, eval_dataset, offline_evaluator
)
candidate = evolution.propose(
    "assistant-prompt", "prompt", "改进后的 prompt",
    "修复失败样例", ["trace-notebook-1"],
)
evaluated = evolution.evaluate(candidate.id)
print("Gate：", evaluated.report.gate_passed, evaluated.report.gate_reasons)
"""
    ),
    code(
        """
evolution.approve(candidate.id, "human-reviewer", "人工抽查通过")
evolution.publish(candidate.id, "release-owner")
print("发布版本：", artifact_store.get_active("assistant-prompt").version)
print("发布后监控：", evolution.monitor_active("assistant-prompt").report.gate_passed)

evolution.rollback("assistant-prompt", 1, "on-call")
print("回滚版本：", artifact_store.get_active("assistant-prompt").version)
print("审计记录：", evolution.release_history())
"""
    ),
    markdown(
        """
## Stage 7：Trace Replay

Recorded trace 可以在不调用模型和真实工具的情况下重复评分。公开 eval 与隐藏 holdout 必须
同时存在；这是一层快速回归检查，不替代真实模型评测。
"""
    ),
    code(
        """
from from_scratch_agent import (
    ReplayEvalCase,
    TraceReplayEvaluator,
    compare_artifacts,
    to_eval_cases,
)

replay_events = [{"type": "agentStart"}, {"type": "agentEnd"}]
def replay_case(case_id, split):
    return ReplayEvalCase(case_id, "退款请求", split, "先核验", "contains", {
        "1": {"artifactVersion": 1, "output": "直接退款", "safetyPassed": False,
              "tokens": 10, "cost": 0.01, "latencyMs": 20, "events": replay_events},
        "2": {"artifactVersion": 2, "output": "先核验订单", "safetyPassed": True,
              "tokens": 10, "cost": 0.01, "latencyMs": 20, "events": replay_events},
    })

replay_dataset = [replay_case("public", "eval"), replay_case("hidden", "holdout")]
replay = TraceReplayEvaluator(replay_dataset)
replay_report = compare_artifacts(
    ArtifactVersion("p", "prompt", 1, "v1", "2026-01-01T00:00:00Z"),
    ArtifactVersion("p", "prompt", 2, "v2", "2026-01-02T00:00:00Z", 1),
    to_eval_cases(replay_dataset), replay,
)
print("Replay gate：", replay_report.gate_passed)
"""
    ),
    markdown(
        """
## Stage 9：安全 Workspace Tools

工具默认只读，所有路径都必须留在唯一 root 中。长输出不会全部塞进 Context，而是保存为
artifact，再按 offset/limit 分段读取。
"""
    ),
    code(
        """
from tempfile import TemporaryDirectory
from from_scratch_agent import create_workspace_toolkit

with TemporaryDirectory() as workspace_directory:
    sample = Path(workspace_directory) / "notes.txt"
    sample.write_text("Agent loop\\n" + "x" * 100, encoding="utf-8")
    workspace_kit = create_workspace_toolkit(
        workspace_directory, max_inline_characters=24
    )
    workspace_tools = {tool.name: tool for tool in workspace_kit.registry.list()}
    print("默认工具：", list(workspace_tools))
    truncated = workspace_tools["read_file"].execute({"path": "notes.txt"})
    print(truncated)
    print(workspace_tools["read_artifact"].execute({
        "id": "artifact-1", "offset": 0, "limit": 10,
    }))
"""
    ),
    markdown(
        """
## Stage 10：MCP 白名单

下面使用内存 transport 模拟 MCP server。真实 stdio 只是替换 transport；discovery 结果仍需
经过宿主 allowlist 才能进入 ToolRegistry。
"""
    ),
    code(
        """
from from_scratch_agent import McpClient

class NotebookMcpTransport:
    def request(self, method, params, request_id=None):
        if method == "initialize":
            return {}
        if method == "tools/list":
            return {"tools": [
                {"name": "lookup", "inputSchema": {"type": "object"}},
                {"name": "admin", "inputSchema": {"type": "object"}},
            ]}
        return {"content": "ok", "token": "hidden"}
    def notify(self, method, params=None):
        pass
    def close(self):
        pass

mcp_registry = McpClient(
    "docs", NotebookMcpTransport(), ["lookup"]
).create_registry()
print("Agent 可见 MCP tools：", [tool.name for tool in mcp_registry.list()])
print(mcp_registry.list()[0].execute({}))
"""
    ),
    markdown(
        """
## Stage 11：Structured Output 与 Router

第一份输出故意不是 JSON；repair 后仍要重新通过同一个宿主 Schema。模型 fallback 与
generator/judge 指标也由普通 Python 对象显式管理。
"""
    ),
    code(
        """
from from_scratch_agent import generate_structured, ModelRoute, ModelRouter

class SequenceOutputModel:
    name = "sequence"
    def __init__(self, outputs):
        self.outputs = list(outputs)
    def generate(self, system_prompt, messages, tools):
        value = self.outputs.pop(0)
        if isinstance(value, Exception):
            raise value
        return {
            "role": "assistant",
            "content": [{"type": "text", "text": value}],
            "usage": {"input": 2, "output": 1},
        }

structured = generate_structured(
    SequenceOutputModel(["broken", '{"answer":"ok"}']),
    "回答", [], {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    },
)
router = ModelRouter([
    ModelRoute("primary", SequenceOutputModel([RuntimeError("offline")])),
    ModelRoute("fallback", SequenceOutputModel(["fallback ok"])),
])
routed = router.generate("回答", [], [], "summary", "generator")
print("repair 次数：", structured.repair_attempts)
print("route：", routed["routed_model"], router.snapshot_metrics())
"""
    ),
    markdown(
        """
## Stage 12：Durable Task

任务先写入 SQLite，再关闭并重新打开 store。第二个进程视角的 worker 仍能 claim、执行并
读取完整事件日志。
"""
    ),
    code(
        """
from from_scratch_agent import SqliteDurableTaskStore, DurableTaskRunner

with TemporaryDirectory() as durable_directory:
    durable_path = Path(durable_directory) / "runtime.sqlite"
    first_store = SqliteDurableTaskStore(durable_path)
    first_store.enqueue("double", {"value": 5}, "notebook-task")
    first_store.close()

    resumed_store = SqliteDurableTaskStore(durable_path)
    runner = DurableTaskRunner(
        resumed_store,
        "worker-1",
        {"double": lambda payload, context: {"value": payload["value"] * 2}},
    )
    durable_result = runner.run_next()
    print(durable_result)
    print([event.type for event in resumed_store.events("notebook-task")])
    resumed_store.close()
"""
    ),
    markdown(
        """
### 7. 可选：调用真实 MiniMax

只有同时设置 `MINIMAX_API_KEY` 和 `RUN_LIVE_MINIMAX=1` 才会真正请求网络。这样重新执行
整个 Notebook 时不会意外消耗额度。
"""
    ),
    code(
        """
import os

if os.environ.get("MINIMAX_API_KEY") and os.environ.get("RUN_LIVE_MINIMAX") == "1":
    from from_scratch_agent import MiniMaxProvider

    live_agent = Agent(
        model=MiniMaxProvider(os.environ["MINIMAX_API_KEY"]),
        tools=[calculator_tool],
        system_prompt="你是可靠的助手，精确计算必须使用工具。",
    )
    for live_event in live_agent.run("精确计算 1234 × 5678"):
        if live_event["type"] in {"tool_start", "tool_end", "text"}:
            pprint(live_event)
else:
    print("已跳过真实 API。需要时设置 MINIMAX_API_KEY 和 RUN_LIVE_MINIMAX=1。")
"""
    ),
    markdown(
        """
## Next Steps

1. 打开 `python/from_scratch_agent/agent.py`，对照这里的事件阅读循环；
2. 给 Agent 新增一个自己的 `Tool`；
3. 阅读 TypeScript 版，观察同一架构如何增加异步、取消和 Web UI；
4. 最后运行 `npm run pi-example`，比较成熟 pi-agent 提供的流式事件和参数校验。

你不需要一次理解所有语法。先盯住唯一的不变量：

> 工具结果必须进入消息历史，然后模型才能在下一轮使用它。
"""
    ),
]

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
nbf.write(notebook, OUTPUT)
print(f"wrote {OUTPUT}")
