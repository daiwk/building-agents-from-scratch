# MCP 接入

MCP 在本项目里只是一个工具来源：

```text
宿主配置 command/args → stdio JSON-RPC → tools/list
                    → allowlist → ToolRegistry → AgentContext
```

关键安全边界是 **discovery 不等于 authorization**。server 返回 `lookup` 和
`admin` 时，如果 `AGENT_MCP_TOOLS=lookup`，Agent 最终只会看到带
namespace 的 `docs__lookup`。

## 配置

```dotenv
AGENT_MCP_COMMAND=node
AGENT_MCP_ARGS=["path/to/server.js"]
AGENT_MCP_SERVER_NAME=docs
AGENT_MCP_TOOLS=lookup
AGENT_MCP_TIMEOUT_MS=30000
# AGENT_MCP_CWD=.
AGENT_TOOLS=calculator,docs__lookup
```

`AGENT_MCP_ARGS` 是 JSON 字符串数组，不经过 shell 拆词。command、args、cwd 与
白名单都由宿主配置，不能来自模型输出。

## 当前协议范围

教学实现支持 initialize、notifications/initialized、tools/list、tools/call 和取消通知。
每行是一条 JSON-RPC 消息，适合看懂 stdio transport。返回值递归隐藏常见 secret 字段。

Resources、Prompts、sampling、HTTP/SSE transport 和完整协议协商暂未实现；生产项目可在
`McpRequestTransport` 后替换成熟 SDK，`Agent` 与
`ToolRegistry` 不需要改变。
