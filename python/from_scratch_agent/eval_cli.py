"""运行共享 JSONL replay dataset：python -m from_scratch_agent.eval_cli ..."""

import argparse
import json
from pathlib import Path

from .evals import (
    JsonEvalReportStore, JsonlEvalDatasetStore, TraceReplayEvaluator,
    dataset_fingerprint, report_to_dict, to_eval_cases,
)
from .evolution import ArtifactVersion, compare_artifacts


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic trace replay eval")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--report", default=".agent-data/evals-python")
    args = parser.parse_args()
    dataset = JsonlEvalDatasetStore(args.dataset).load()
    baseline = _artifact(args.baseline)
    candidate = _artifact(args.candidate)
    report = compare_artifacts(
        baseline, candidate, to_eval_cases(dataset), TraceReplayEvaluator(dataset)
    )
    stored = {
        "dataset_fingerprint": dataset_fingerprint(dataset),
        "baseline_version": baseline.version,
        "candidate_version": candidate.version,
        "report": report_to_dict(report),
    }
    report_file = JsonEvalReportStore(args.report).save(stored)
    print(json.dumps({"report_file": str(report_file), **stored}, ensure_ascii=False, indent=2))
    return 0 if report.gate_passed else 2


def _artifact(file_path: str) -> ArtifactVersion:
    raw = json.loads(Path(file_path).read_text(encoding="utf-8"))
    return ArtifactVersion(
        raw["artifactId"], raw["kind"], raw["version"], raw["content"],
        raw["createdAt"], raw.get("parentVersion"),
    )


if __name__ == "__main__":
    raise SystemExit(main())
