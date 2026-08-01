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
