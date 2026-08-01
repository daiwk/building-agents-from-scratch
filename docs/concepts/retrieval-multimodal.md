# Retrieval、上传与多模态

## 带引用的知识检索

`HybridRetriever` 把文档切成带 `sourceId`、`chunkId`、原文位置和 URI 的块。默认用本地
BM25；注入 `EmbeddingProvider` 后，再用 reciprocal-rank fusion 合并词法与向量排名。

```ts
const retriever = new HybridRetriever();
await retriever.ingest([{
  id: "manual", title: "使用手册", uri: "/manual",
  text: "Tool 由宿主执行。",
}]);

const hits = await retriever.search("谁执行工具？");
// hits[0].citation 可以追溯到 manual 和具体 chunk。
```

把 `createKnowledgeSearchTool(retriever)` 注册给 Agent，模型得到的是 snippet 加结构化引用，
而不是一个无法解释的相似度数字。pi-agent 版可把文档数组保存为 JSON，并设置：

```bash
AGENT_KNOWLEDGE_FILE=knowledge.json
PI_AGENT_TOOLS=search_knowledge
```

## 文件如何进入模型

网页先调用 `POST /api/artifacts` 保存文件，再把返回的 id 放进 `/api/chat`。服务端将图片
转换成 image content block，将纯文本、Markdown 和 JSON 转换成带文件名边界的 text block。
从头实现版和 Python 版都允许 `Agent.run()` 接收 content block；pi-agent 使用
`promptPiAgentWithArtifacts()` 适配到它的原生 `ImageContent`。

允许的类型只有 `text/plain`、`text/markdown`、`application/json`、PNG、JPEG 和 WebP，
单文件上限 2 MB。响应中的 SHA-256 用于完整性校验，不等于恶意文件检测。

!!! warning "生产环境仍需补齐"

    当前 ArtifactStore 是内存教学实现。外网部署前还需要认证、租户隔离、对象存储、
    病毒扫描、配额、审计和短期签名下载链接。
