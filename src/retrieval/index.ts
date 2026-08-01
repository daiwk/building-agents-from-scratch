import type { JsonValue, Tool } from "../core/index.js";

export type SourceDocument = { id: string; title: string; text: string; uri?: string };
export type DocumentChunk = {
  id: string; sourceId: string; title: string; text: string;
  start: number; end: number; uri?: string; embedding?: number[];
};
export type RetrievalHit = {
  score: number; snippet: string;
  citation: { sourceId: string; chunkId: string; title: string; start: number; end: number; uri?: string };
};
export type EmbeddingProvider = { embed(texts: readonly string[]): Promise<number[][]> };

/** 先按段落切块并保留字符位置；引用因此可以回到原文，而不是只返回相似度数字。 */
export function chunkDocument(document: SourceDocument, maxCharacters = 800): DocumentChunk[] {
  if (maxCharacters <= 0) throw new Error("maxCharacters must be positive.");
  const chunks: DocumentChunk[] = [];
  const paragraphs = [...document.text.matchAll(/[^\n]+(?:\n+|$)/g)];
  let buffer = "";
  let start = 0;
  const flush = () => {
    const text = buffer.trim();
    if (!text) return;
    chunks.push({
      id: document.id + "#" + chunks.length, sourceId: document.id,
      title: document.title, text, start, end: start + buffer.length,
      ...(document.uri ? { uri: document.uri } : {}),
    });
    buffer = "";
  };
  for (const match of paragraphs) {
    const paragraph = match[0]!;
    if (buffer && buffer.length + paragraph.length > maxCharacters) {
      flush();
      start = match.index;
    }
    if (!buffer) start = match.index;
    if (paragraph.length <= maxCharacters) buffer += paragraph;
    else {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += maxCharacters) {
        const text = paragraph.slice(offset, offset + maxCharacters).trim();
        if (text) chunks.push({
          id: document.id + "#" + chunks.length, sourceId: document.id,
          title: document.title, text, start: match.index + offset,
          end: match.index + offset + text.length,
          ...(document.uri ? { uri: document.uri } : {}),
        });
      }
      start = match.index + paragraph.length;
    }
  }
  flush();
  return chunks;
}

/** BM25 与可选向量排名通过 reciprocal-rank fusion 合并；没有 embedding 时仍可离线运行。 */
export class HybridRetriever {
  private chunks: DocumentChunk[] = [];
  constructor(private readonly embeddings?: EmbeddingProvider) {}

  async ingest(documents: readonly SourceDocument[]): Promise<void> {
    const chunks = documents.flatMap((document) => chunkDocument(document));
    if (this.embeddings && chunks.length) {
      const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.text));
      if (vectors.length !== chunks.length) throw new Error("Embedding count mismatch.");
      chunks.forEach((chunk, index) => {
        const vector = vectors[index];
        if (vector) chunk.embedding = vector;
      });
    }
    this.chunks.push(...chunks);
  }

  async search(query: string, limit = 5): Promise<RetrievalHit[]> {
    if (!query.trim()) return [];
    const lexical = bm25(query, this.chunks);
    const vector = this.embeddings
      ? cosineRank((await this.embeddings.embed([query]))[0] ?? [], this.chunks)
      : [];
    const scores = new Map<string, number>();
    [lexical, vector].forEach((ranking) => ranking.forEach((chunk, rank) => {
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (60 + rank + 1));
    }));
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id, score]) => {
        const chunk = this.chunks.find((item) => item.id === id)!;
        return {
          score, snippet: chunk.text,
          citation: {
            sourceId: chunk.sourceId, chunkId: chunk.id, title: chunk.title,
            start: chunk.start, end: chunk.end,
            ...(chunk.uri ? { uri: chunk.uri } : {}),
          },
        };
      });
  }
}

export function createKnowledgeSearchTool(retriever: HybridRetriever): Tool {
  return {
    name: "search_knowledge",
    description: "检索已摄取文档，并返回可核验引用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input) {
      return JSON.stringify(await retriever.search(
        String(input.query), typeof input.limit === "number" ? input.limit : 5,
      ));
    },
  };
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((word) =>
    word.length > 2 && /[\u3400-\u9fff]/u.test(word) ? [...word] : [word],
  );
}

function bm25(query: string, chunks: readonly DocumentChunk[]): DocumentChunk[] {
  const terms = tokens(query);
  const docs = chunks.map((chunk) => tokens(chunk.text));
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  return chunks.map((chunk, index) => {
    const doc = docs[index]!;
    const score = terms.reduce((sum, term) => {
      const tf = doc.filter((token) => token === term).length;
      const df = docs.filter((tokens) => tokens.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      return sum + idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / Math.max(1, average)));
    }, 0);
    return { chunk, score };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .map((item) => item.chunk);
}

function cosineRank(query: number[], chunks: readonly DocumentChunk[]): DocumentChunk[] {
  return chunks.map((chunk) => ({ chunk, score: cosine(query, chunk.embedding ?? []) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .map((item) => item.chunk);
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const norm = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0));
  return dot / Math.max(Number.EPSILON, norm(left) * norm(right));
}
