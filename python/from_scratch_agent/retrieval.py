"""带引用的教学版混合检索；标准库即可运行。"""

import math
import re
from dataclasses import dataclass
from typing import Protocol

from .types import Tool


@dataclass
class SourceDocument:
    id: str
    title: str
    text: str
    uri: str | None = None


@dataclass
class DocumentChunk:
    id: str
    source_id: str
    title: str
    text: str
    start: int
    end: int
    uri: str | None = None
    embedding: list[float] | None = None


class EmbeddingProvider(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


def chunk_document(document: SourceDocument, max_characters: int = 800) -> list[DocumentChunk]:
    """按固定长度切块并保留原文位置，引用可以回到 source。"""
    if max_characters <= 0:
        raise ValueError("max_characters must be positive")
    chunks = []
    for start in range(0, len(document.text), max_characters):
        raw = document.text[start : start + max_characters]
        text = raw.strip()
        if text:
            chunks.append(DocumentChunk(
                f"{document.id}#{len(chunks)}", document.id, document.title,
                text, start, start + len(raw), document.uri,
            ))
    return chunks


class HybridRetriever:
    """BM25 与可选向量排名用 reciprocal-rank fusion 合并。"""

    def __init__(self, embeddings: EmbeddingProvider | None = None) -> None:
        self.embeddings = embeddings
        self.chunks: list[DocumentChunk] = []

    def ingest(self, documents: list[SourceDocument]) -> None:
        chunks = [chunk for doc in documents for chunk in chunk_document(doc)]
        if self.embeddings and chunks:
            vectors = self.embeddings.embed([chunk.text for chunk in chunks])
            if len(vectors) != len(chunks):
                raise ValueError("Embedding count mismatch")
            for chunk, vector in zip(chunks, vectors, strict=True):
                chunk.embedding = vector
        self.chunks.extend(chunks)

    def search(self, query: str, limit: int = 5) -> list[dict]:
        lexical = _bm25(query, self.chunks)
        vector = []
        if self.embeddings:
            query_vector = self.embeddings.embed([query])[0]
            vector = sorted(
                (chunk for chunk in self.chunks if _cosine(query_vector, chunk.embedding or []) > 0),
                key=lambda chunk: (-_cosine(query_vector, chunk.embedding or []), chunk.id),
            )
        scores: dict[str, float] = {}
        for ranking in (lexical, vector):
            for rank, chunk in enumerate(ranking):
                scores[chunk.id] = scores.get(chunk.id, 0) + 1 / (61 + rank)
        by_id = {chunk.id: chunk for chunk in self.chunks}
        return [{
            "score": score,
            "snippet": by_id[chunk_id].text,
            "citation": {
                "source_id": by_id[chunk_id].source_id,
                "chunk_id": chunk_id,
                "title": by_id[chunk_id].title,
                "start": by_id[chunk_id].start,
                "end": by_id[chunk_id].end,
                **({"uri": by_id[chunk_id].uri} if by_id[chunk_id].uri else {}),
            },
        } for chunk_id, score in sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def create_knowledge_search_tool(retriever: HybridRetriever) -> Tool:
    import json
    return Tool(
        "search_knowledge", "检索已摄取文档，并返回可核验引用。",
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        lambda args: json.dumps(retriever.search(str(args["query"])), ensure_ascii=False),
    )


def _tokens(text: str) -> list[str]:
    words = re.findall(r"[\w]+", text.lower())
    return [char for word in words for char in (list(word) if re.search(r"[\u3400-\u9fff]", word) else [word])]


def _bm25(query: str, chunks: list[DocumentChunk]) -> list[DocumentChunk]:
    terms, docs = _tokens(query), [_tokens(chunk.text) for chunk in chunks]
    average = sum(map(len, docs)) / max(1, len(docs))
    scored = []
    for chunk, doc in zip(chunks, docs, strict=True):
        score = 0.0
        for term in terms:
            tf, df = doc.count(term), sum(term in item for item in docs)
            score += math.log(1 + (len(docs) - df + .5) / (df + .5)) * (tf * 2.2) / max(.0001, tf + 1.2 * (.25 + .75 * len(doc) / max(1, average)))
        if score > 0:
            scored.append((score, chunk))
    return [chunk for _, chunk in sorted(scored, key=lambda item: (-item[0], item[1].id))]


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0
    return sum(a * b for a, b in zip(left, right, strict=True)) / max(1e-12, math.sqrt(sum(a*a for a in left)) * math.sqrt(sum(b*b for b in right)))
