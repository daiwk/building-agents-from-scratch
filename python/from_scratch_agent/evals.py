"""固定 JSONL 数据集和不访问模型/工具的 trace replay。"""

from dataclasses import asdict, dataclass
from hashlib import sha256
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import time_ns

from .evolution import (
    ArtifactVersion, EvalCase, EvalSampleResult, EvaluationReport,
)


@dataclass(frozen=True)
class ReplayEvalCase:
    id: str
    input: str
    split: str
    expected: str
    rubric: str
    runs: dict[str, dict]


class TraceReplayEvaluator:
    def __init__(self, dataset: list[ReplayEvalCase]) -> None:
        validate_replay_dataset(dataset)
        self.cases = {case.id: case for case in dataset}

    def __call__(self, artifact: ArtifactVersion, test_case: EvalCase) -> EvalSampleResult:
        fixture = self.cases.get(test_case.id)
        if fixture is None:
            raise ValueError(f"找不到 Replay case：{test_case.id}")
        run = fixture.runs.get(str(artifact.version))
        if run is None:
            raise ValueError(f"没有记录 {test_case.id}@{artifact.version}")
        validate_trace_events(run["events"])
        output = run["output"]
        passed = (
            output.strip() == fixture.expected.strip()
            if fixture.rubric == "equals" else fixture.expected in output
        )
        return EvalSampleResult(
            output, passed, bool(run["safetyPassed"]), int(run["tokens"]),
            float(run["cost"]), float(run["latencyMs"]),
        )


class JsonlEvalDatasetStore:
    def __init__(self, file_path: str | Path) -> None:
        self.file_path = Path(file_path)

    def load(self) -> list[ReplayEvalCase]:
        dataset = [ReplayEvalCase(**json.loads(line)) for line in (
            self.file_path.read_text(encoding="utf-8").splitlines()
        ) if line]
        validate_replay_dataset(dataset)
        return dataset

    def save(self, dataset: list[ReplayEvalCase]) -> None:
        validate_replay_dataset(dataset)
        text = "\n".join(json.dumps(asdict(case), ensure_ascii=False) for case in dataset) + "\n"
        _atomic_write(self.file_path, text)


class JsonEvalReportStore:
    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)

    def save(self, report: dict) -> Path:
        target = self.directory / f"eval-{time_ns()}.json"
        _atomic_write(target, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        return target

    def load(self, file_path: str | Path) -> dict:
        return json.loads(Path(file_path).read_text(encoding="utf-8"))


def to_eval_cases(dataset: list[ReplayEvalCase]) -> list[EvalCase]:
    return [EvalCase(case.id, case.input, case.split, case.expected) for case in dataset]


def dataset_fingerprint(dataset: list[ReplayEvalCase]) -> str:
    lines = [json.dumps(asdict(case), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
             for case in sorted(dataset, key=lambda item: item.id)]
    return sha256("\n".join(lines).encode()).hexdigest()


def report_to_dict(report: EvaluationReport) -> dict:
    return asdict(report)


def validate_replay_dataset(dataset):
    if not dataset:
        raise ValueError("Replay dataset 不能为空")
    ids = [case.id for case in dataset]
    if any(not item for item in ids) or len(ids) != len(set(ids)):
        raise ValueError("Replay id 必须非空且唯一")
    if {case.split for case in dataset} != {"eval", "holdout"}:
        raise ValueError("Replay dataset 必须同时包含 eval 和 holdout")
    for case in dataset:
        if case.rubric not in {"equals", "contains"} or not case.runs:
            raise ValueError(f"Replay case 无效：{case.id}")
        for version, run in case.runs.items():
            if str(run["artifactVersion"]) != version:
                raise ValueError(f"Replay version key 不匹配：{case.id}")
            validate_trace_events(run["events"])


def validate_trace_events(events):
    if not events or events[0].get("type") != "agentStart" or events[-1].get("type") != "agentEnd":
        raise ValueError("Replay trace 必须从 agentStart 开始并以 agentEnd 结束")
    active = set()
    for event in events:
        if event.get("type") == "toolStart":
            if event.get("callId") in active:
                raise ValueError("重复 tool call")
            active.add(event.get("callId"))
        if event.get("type") == "toolEnd" and event.get("callId") not in active:
            raise ValueError("toolEnd 缺少 toolStart")
        if event.get("type") == "toolEnd":
            active.remove(event.get("callId"))
    if active:
        raise ValueError("Replay trace 存在未完成 tool call")


def _atomic_write(target: Path, content: str):
    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, delete=False) as temporary:
        temporary.write(content)
        temporary_path = Path(temporary.name)
    temporary_path.chmod(0o600)
    temporary_path.replace(target)
