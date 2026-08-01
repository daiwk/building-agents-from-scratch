import unittest

from from_scratch_agent.artifacts import InMemoryArtifactStore
from from_scratch_agent.retrieval import HybridRetriever, SourceDocument


class Stage1314Tests(unittest.TestCase):
    def test_retrieval_has_citation(self):
        retriever = HybridRetriever()
        retriever.ingest([SourceDocument("guide", "指南", "工具由宿主执行。", "/guide")])
        hit = retriever.search("工具宿主")[0]
        self.assertEqual(hit["citation"]["source_id"], "guide")
        self.assertEqual(hit["citation"]["uri"], "/guide")

    def test_artifact_allowlist_and_hash(self):
        store = InMemoryArtifactStore(20)
        with self.assertRaises(ValueError):
            store.create("test", "bad.sh", "application/x-sh", b"echo bad")
        self.assertEqual(len(store.create("test", "ok.txt", "text/plain", b"hello").sha256), 64)


if __name__ == "__main__":
    unittest.main()
