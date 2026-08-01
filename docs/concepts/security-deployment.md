# 认证、租户、RBAC 与部署

Stage 15 把安全放在 Agent loop 外层：模型永远不能给自己认证、切换租户或扩大权限。

## Bearer Key 认证

认证配置只保存 Key 的 SHA-256，不保存明文。先生成随机 Key 和摘要：

```bash
openssl rand -hex 24
printf '%s' '上一步生成的Key' | shasum -a 256
```

复制 `deploy/auth.example.json` 为 `deploy/auth.json`，填写摘要、主体、租户和角色。然后设置：

```bash
AGENT_AUTH_CONFIG=deploy/auth.json npm run web
```

不设置 `AGENT_AUTH_CONFIG` 时使用 `local-developer/local/admin`，只适合绑定在
`127.0.0.1` 的本地教学。配置文件存在后，`/api/chat`、Artifact、reset 和 audit 都要求
`Authorization: Bearer ...`。Web 页右上角可以把 Key 保存到当前标签页的
`sessionStorage`；关闭标签页后即消失。

服务默认绑定 `127.0.0.1`。如果把 `AGENT_HOST` 设成 `0.0.0.0` 或其他非 loopback 地址却
没有配置认证，进程会拒绝启动；Compose 已同时设置认证 config 和容器监听地址。

## 租户隔离

浏览器传来的 session id 不能直接作为数据库 key。服务端用
`SHA-256(tenantId + NUL + sessionId)` 生成内部 session key；两个租户即使使用相同 id，
也不会共享 ConversationStore。ArtifactStore 的 `create/get` 同样强制传入 tenant id，
跨租户读取统一返回 404，避免泄露资源是否存在。

## RBAC

内置角色保持少而透明：

| 角色 | 权限 |
| --- | --- |
| `user` | chat、自己的 Artifact、reset，以及三个内置只读/计算工具 |
| `builder` | `user` 权限，加 `tool:*`、`skill:*`、`resource:*` |
| `auditor` | 读取本租户审计事件 |
| `admin` | 全部权限 |

Web identity 会一直传入 Agent 装配层。工具注册、Skill 注入和 workspace 加载前都会调用
`authorize()`；所以 RBAC 不是只保护 HTTP 路由。pi-agent 使用
`PI_AGENT_ROLE`、`PI_AGENT_TENANT_ID` 和 `PI_AGENT_SUBJECT` 复用相同规则。

## 密钥与审计

`EnvironmentSecretProvider` 支持 `NAME` 和 `NAME_FILE`，但没有“列出所有密钥”的接口。
MiniMax 的两套 TypeScript 入口都支持 `MINIMAX_API_KEY_FILE`。审计记录仅包含主体、租户、
action、outcome、resource id 和受控 metadata；不会保存 prompt、工具参数、文件内容或 Key。

## Docker Compose

```bash
cp deploy/auth.example.json deploy/auth.json
mkdir -p deploy/secrets
printf '%s' '你的 MiniMax Key' > deploy/secrets/minimax_api_key.txt
# 编辑 deploy/auth.json 后：
docker compose up --build
```

模板只监听宿主 `127.0.0.1:3000`，使用只读根文件系统、非 root 用户、drop capabilities、
`no-new-privileges`、只读 config、Docker secret 和独立 `/data` volume。要开放公网，还必须
在前面部署 TLS reverse proxy，并按组织要求加入备份、日志留存、速率限制和密钥轮换。

!!! warning "教学实现的边界"

    SHA-256 Key 认证适合解释原理和小型自托管。企业生产环境通常应接 OIDC/OAuth、KMS、
    集中策略引擎和不可篡改审计存储，而不是继续扩展本地 JSON 文件。
