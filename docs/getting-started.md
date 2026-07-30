# 5 分钟上手

## 环境要求

- Node.js 22.19 或更高版本；
- Python 3.11 或更高版本；
- 只有调用真实 MiniMax 时才需要 API Key。

## 1. 安装

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-docs.txt
```

## 2. 先跑离线示例

=== "Python 单元测试"

    ```bash
    PYTHONPATH=python .venv/bin/python -m unittest discover -s python/tests -v
    ```

=== "Notebook"

    ```bash
    .venv/bin/jupyter notebook notebooks/agent_from_scratch.ipynb
    ```

=== "pi-agent 配置检查"

    ```bash
    npm run pi-check
    ```

这三项都不会调用真实模型。

## 3. 配置国内 MiniMax

复制环境变量模板：

```bash
cp .env.example .env
```

填写：

```dotenv
MINIMAX_API_KEY=你的国内站_Key
MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic/v1
MINIMAX_MODEL=MiniMax-M2.7
AGENT_PROVIDER=minimax
```

!!! warning "国内站与国际站不能混用"
    本项目默认使用国内站 `api.minimaxi.com`。国内站 Key 不应发送到
    `api.minimax.io`，反过来也一样。

## 4. 选择界面

网页版：

```bash
npm run web
```

打开 `http://127.0.0.1:3000`。右侧执行轨迹会明确显示“运行中、等待模型、已完成或失败”，
对话区和轨迹区都能独立滚动。

终端版：

```bash
npm run dev
```

Python 版：

```bash
PYTHONPATH=python .venv/bin/python -m from_scratch_agent.cli
```

## 5. 第一段应该读的代码

打开 `python/from_scratch_agent/agent.py` 或 `src/core/agent-loop.ts`，找到“工具结果写回
context”的那一行。理解这一行，就理解了最小 Agent 的闭环。
