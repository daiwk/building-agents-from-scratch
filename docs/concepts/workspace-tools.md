# 安全 Workspace Tools

计算器可以解释 tool loop，但真实 Agent 通常需要读写项目文件。Stage 9 增加一组小型文件
工具，同时把权限边界保持在 Agent loop 外层。

## 启用

```dotenv
AGENT_WORKSPACE_ROOT=.
AGENT_TOOLS=read_artifact,list_files,read_file,search_text
AGENT_WORKSPACE_ALLOW_WRITE=false
```

需要写入时必须同时显式选择 `write_file` 并开启：

```dotenv
AGENT_TOOLS=read_artifact,list_files,read_file,search_text,write_file
AGENT_WORKSPACE_ALLOW_WRITE=true
```

只设置 `allowWrite` 不会让模型自动调用工具；ToolRegistry 的名称白名单仍然是第二层授权。

## 安全边界

- 只接受相对路径；解析后的路径必须位于唯一 workspace root；
- existing path 使用 realpath 再检查，阻止 symlink 跳出目录；
- 遍历不会跟随 symlink，并默认跳过 `.git`、`node_modules` 和 `.agent-data`；
- read/write、文件数量与搜索结果都有上限；
- write 使用同目录临时文件后原子替换；
- 不提供 shell、网络、删除和递归目录写入。

## 长输出为什么变成 Artifact

把数十万字符的文件或搜索结果直接加入 Context 会快速消耗 token。超过
`maxInlineCharacters` 时，工具只返回开头、artifact ID 和总长度；Agent 可以调用
`read_artifact` 按 offset/limit 分段读取。

内存 ArtifactStore 适合教学和单进程 CLI。生产环境应接对象存储，增加租户隔离、过期时间、
下载授权、内容类型检查和恶意文件扫描。
