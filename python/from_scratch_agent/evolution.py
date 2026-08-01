"""Stage 6：模型只能提候选，评测、人工审批、发布和回滚彼此分离。"""

from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from math import inf, isfinite
from typing import Callable


@dataclass(frozen=True)
class ArtifactVersion:
    artifact_id: str
    kind: str
    version: int
    content: str
    created_at: str
    parent_version: int | None = None


@dataclass(frozen=True)
class EvalCase:
    id: str
    input: str
    split: str
    expected: str | None = None


@dataclass(frozen=True)
class EvalSampleResult:
    output: str
    passed: bool
    safety_passed: bool
    tokens: int
    cost: float
    latency_ms: float


@dataclass(frozen=True)
class EvalMetrics:
    total: int
    passed: int
    pass_rate: float
    safety_pass_rate: float
    total_tokens: int
    total_cost: float
    average_latency_ms: float


@dataclass(frozen=True)
class GatePolicy:
    min_eval_pass_rate: float = 0.8
    min_holdout_pass_rate: float = 0.8
    min_eval_quality_delta: float = 0.0
    min_holdout_quality_delta: float = 0.0
    max_cost_increase_ratio: float = 1.2
    max_latency_increase_ratio: float = 1.2
    max_token_increase_ratio: float = 1.2
    require_all_safety_passed: bool = True


@dataclass(frozen=True)
class EvaluationReport:
    baseline_eval: EvalMetrics
    baseline_holdout: EvalMetrics
    candidate_eval: EvalMetrics
    candidate_holdout: EvalMetrics
    gate_passed: bool
    gate_reasons: tuple[str, ...]


@dataclass(frozen=True)
class EvolutionCandidate:
    id: str
    artifact: ArtifactVersion
    rationale: str
    failure_trace_ids: tuple[str, ...]
    status: str = "proposed"
    report: EvaluationReport | None = None
    reviewed_by: str | None = None
    review_note: str | None = None


@dataclass(frozen=True)
class ReleaseRecord:
    action: str
    artifact_id: str
    version: int
    actor: str
    timestamp: str
    candidate_id: str | None = None


@dataclass(frozen=True)
class MonitoringRecord:
    artifact_id: str
    version: int
    timestamp: str
    report: EvaluationReport


ArtifactEvaluator = Callable[[ArtifactVersion, EvalCase], EvalSampleResult]


class InMemoryArtifactStore:
    """不可覆盖已有版本；生产环境可替换成数据库或制品仓库。"""

    def __init__(self) -> None:
        self._versions: dict[str, dict[int, ArtifactVersion]] = {}
        self._active: dict[str, int] = {}

    def put(self, artifact: ArtifactVersion) -> None:
        _validate_artifact(artifact)
        versions = self._versions.setdefault(artifact.artifact_id, {})
        if artifact.version in versions:
            raise ValueError(
                f"Artifact version 已存在：{artifact.artifact_id}@{artifact.version}"
            )
        versions[artifact.version] = deepcopy(artifact)

    def get(self, artifact_id: str, version: int) -> ArtifactVersion | None:
        return deepcopy(self._versions.get(artifact_id, {}).get(version))

    def get_active(self, artifact_id: str) -> ArtifactVersion | None:
        version = self._active.get(artifact_id)
        return None if version is None else self.get(artifact_id, version)

    def list(self, artifact_id: str) -> list[ArtifactVersion]:
        versions = self._versions.get(artifact_id, {})
        return [deepcopy(versions[key]) for key in sorted(versions)]

    def activate(self, artifact_id: str, version: int) -> None:
        if version not in self._versions.get(artifact_id, {}):
            raise ValueError(f"未知 Artifact version：{artifact_id}@{version}")
        self._active[artifact_id] = version


class EvolutionController:
    def __init__(self, store: InMemoryArtifactStore, dataset: list[EvalCase],
                 evaluator: ArtifactEvaluator, policy: GatePolicy | None = None) -> None:
        _validate_dataset(dataset)
        self.store = store
        self.dataset = deepcopy(dataset)
        self.evaluator = evaluator
        self.policy = policy or GatePolicy()
        _validate_policy(self.policy)
        self.candidates: dict[str, EvolutionCandidate] = {}
        self.releases: list[ReleaseRecord] = []
        self.monitoring: list[MonitoringRecord] = []
        self._next_candidate = 1

    def propose(self, artifact_id: str, kind: str, content: str, rationale: str,
                failure_trace_ids: list[str]) -> EvolutionCandidate:
        baseline = self._require_active(artifact_id)
        if baseline.kind != kind:
            raise ValueError("Candidate kind 必须与当前 Artifact 一致")
        if not failure_trace_ids:
            raise ValueError("Candidate 必须关联至少一个失败 trace")
        version = max(item.version for item in self.store.list(artifact_id)) + 1
        candidate = EvolutionCandidate(
            id=f"candidate-{self._next_candidate}",
            artifact=ArtifactVersion(
                artifact_id, kind, version, content, _now(), baseline.version
            ),
            rationale=rationale,
            failure_trace_ids=tuple(failure_trace_ids),
        )
        _validate_artifact(candidate.artifact)
        if not rationale.strip() or any(not item.strip() for item in failure_trace_ids):
            raise ValueError("Candidate rationale 和失败 trace id 不能为空")
        self._next_candidate += 1
        self.candidates[candidate.id] = candidate
        return deepcopy(candidate)

    def evaluate(self, candidate_id: str) -> EvolutionCandidate:
        candidate = self._require_candidate(candidate_id)
        if candidate.status not in {"proposed", "evaluated"}:
            raise ValueError(f"当前状态不能评测：{candidate.status}")
        baseline = self.store.get(
            candidate.artifact.artifact_id, candidate.artifact.parent_version
        )
        if baseline is None:
            raise ValueError("Candidate baseline version 已不存在")
        report = compare_artifacts(
            baseline,
            candidate.artifact,
            self.dataset,
            self.evaluator,
            self.policy,
        )
        updated = replace(candidate, status="evaluated", report=report)
        self.candidates[candidate_id] = updated
        return deepcopy(updated)

    def approve(self, candidate_id: str, approved_by: str,
                note: str | None = None) -> EvolutionCandidate:
        candidate = self._require_candidate(candidate_id)
        if candidate.status != "evaluated" or candidate.report is None:
            raise ValueError("Candidate 必须先完成评测")
        if not candidate.report.gate_passed:
            raise ValueError(
                "Candidate 未通过 release gate：" + "; ".join(candidate.report.gate_reasons)
            )
        if not approved_by.strip():
            raise ValueError("approved_by 不能为空")
        updated = replace(
            candidate, status="approved", reviewed_by=approved_by, review_note=note
        )
        self.candidates[candidate_id] = updated
        return deepcopy(updated)

    def reject(self, candidate_id: str, actor: str, note: str) -> EvolutionCandidate:
        candidate = self._require_candidate(candidate_id)
        if candidate.status == "published":
            raise ValueError("已发布 Candidate 不能 reject")
        if not actor.strip() or not note.strip():
            raise ValueError("reject actor 和 note 不能为空")
        updated = replace(
            candidate, status="rejected", reviewed_by=actor, review_note=note
        )
        self.candidates[candidate_id] = updated
        return deepcopy(updated)

    def publish(self, candidate_id: str, actor: str) -> ArtifactVersion:
        candidate = self._require_candidate(candidate_id)
        if candidate.status != "approved":
            raise ValueError("只有人工批准的 Candidate 才能发布")
        if not actor.strip():
            raise ValueError("publish actor 不能为空")
        active = self._require_active(candidate.artifact.artifact_id)
        if active.version != candidate.artifact.parent_version:
            raise ValueError("Active artifact 已变化；请基于新版本重新提出并评测")
        self.store.put(candidate.artifact)
        self.store.activate(candidate.artifact.artifact_id, candidate.artifact.version)
        self.candidates[candidate_id] = replace(candidate, status="published")
        self.releases.append(ReleaseRecord(
            "publish", candidate.artifact.artifact_id, candidate.artifact.version,
            actor, _now(), candidate_id,
        ))
        return deepcopy(candidate.artifact)

    def rollback(self, artifact_id: str, version: int, actor: str) -> ArtifactVersion:
        if not actor.strip():
            raise ValueError("rollback actor 不能为空")
        artifact = self.store.get(artifact_id, version)
        if artifact is None:
            raise ValueError(f"未知 rollback 目标：{artifact_id}@{version}")
        self.store.activate(artifact_id, version)
        self.releases.append(ReleaseRecord(
            "rollback", artifact_id, version, actor, _now()
        ))
        return artifact

    def monitor_active(self, artifact_id: str) -> MonitoringRecord:
        active = self._require_active(artifact_id)
        if active.parent_version is None:
            raise ValueError("Active artifact 没有可用于监控对比的父版本")
        baseline = self.store.get(artifact_id, active.parent_version)
        if baseline is None:
            raise ValueError("监控 baseline version 已不存在")
        report = compare_artifacts(
            baseline, active, self.dataset, self.evaluator, self.policy
        )
        record = MonitoringRecord(artifact_id, active.version, _now(), report)
        self.monitoring.append(record)
        return deepcopy(record)

    def release_history(self) -> list[ReleaseRecord]:
        return deepcopy(self.releases)

    def monitoring_history(self) -> list[MonitoringRecord]:
        return deepcopy(self.monitoring)

    def _require_active(self, artifact_id: str) -> ArtifactVersion:
        artifact = self.store.get_active(artifact_id)
        if artifact is None:
            raise ValueError(f"没有 active baseline：{artifact_id}")
        return artifact

    def _require_candidate(self, candidate_id: str) -> EvolutionCandidate:
        candidate = self.candidates.get(candidate_id)
        if candidate is None:
            raise ValueError(f"未知 Candidate：{candidate_id}")
        return deepcopy(candidate)


def compare_artifacts(baseline: ArtifactVersion, candidate: ArtifactVersion,
                      dataset: list[EvalCase], evaluator: ArtifactEvaluator,
                      policy: GatePolicy | None = None) -> EvaluationReport:
    _validate_dataset(dataset)
    gate_policy = policy or GatePolicy()
    _validate_policy(gate_policy)
    baseline_results = [_run_case(evaluator, baseline, case) for case in dataset]
    candidate_results = [_run_case(evaluator, candidate, case) for case in dataset]
    baseline_eval = _summarize(dataset, baseline_results, "eval")
    baseline_holdout = _summarize(dataset, baseline_results, "holdout")
    candidate_eval = _summarize(dataset, candidate_results, "eval")
    candidate_holdout = _summarize(dataset, candidate_results, "holdout")
    reasons = _gate_reasons(
        baseline_eval, baseline_holdout, candidate_eval, candidate_holdout, gate_policy
    )
    return EvaluationReport(
        baseline_eval, baseline_holdout, candidate_eval, candidate_holdout,
        not reasons, tuple(reasons),
    )


def _run_case(evaluator, artifact, case):
    result = evaluator(deepcopy(artifact), deepcopy(case))
    for name, value in (
        ("tokens", result.tokens), ("cost", result.cost),
        ("latency_ms", result.latency_ms),
    ):
        if not isfinite(value) or value < 0:
            raise ValueError(f"Eval case {case.id} 的 {name} 无效")
    return deepcopy(result)


def _summarize(dataset, results, split):
    selected = [result for case, result in zip(dataset, results) if case.split == split]
    total = len(selected)
    passed = sum(result.passed for result in selected)
    return EvalMetrics(
        total, passed, passed / total,
        sum(result.safety_passed for result in selected) / total,
        sum(result.tokens for result in selected),
        sum(result.cost for result in selected),
        sum(result.latency_ms for result in selected) / total,
    )


def _gate_reasons(base_eval, base_holdout, candidate_eval, candidate_holdout, policy):
    reasons = []
    if candidate_eval.pass_rate < policy.min_eval_pass_rate:
        reasons.append("eval pass rate below minimum")
    if candidate_holdout.pass_rate < policy.min_holdout_pass_rate:
        reasons.append("holdout pass rate below minimum")
    if candidate_eval.pass_rate - base_eval.pass_rate < policy.min_eval_quality_delta:
        reasons.append("eval quality delta below minimum")
    if candidate_holdout.pass_rate - base_holdout.pass_rate < policy.min_holdout_quality_delta:
        reasons.append("holdout quality delta below minimum")
    if _ratio(candidate_eval.total_cost, base_eval.total_cost) > policy.max_cost_increase_ratio:
        reasons.append("cost increase exceeds limit")
    if _ratio(candidate_holdout.total_cost, base_holdout.total_cost) > policy.max_cost_increase_ratio:
        reasons.append("holdout cost increase exceeds limit")
    if _ratio(candidate_eval.average_latency_ms, base_eval.average_latency_ms) > policy.max_latency_increase_ratio:
        reasons.append("latency increase exceeds limit")
    if _ratio(candidate_holdout.average_latency_ms, base_holdout.average_latency_ms) > policy.max_latency_increase_ratio:
        reasons.append("holdout latency increase exceeds limit")
    if _ratio(candidate_eval.total_tokens, base_eval.total_tokens) > policy.max_token_increase_ratio:
        reasons.append("token increase exceeds limit")
    if _ratio(candidate_holdout.total_tokens, base_holdout.total_tokens) > policy.max_token_increase_ratio:
        reasons.append("holdout token increase exceeds limit")
    if policy.require_all_safety_passed and (
        candidate_eval.safety_pass_rate < 1 or candidate_holdout.safety_pass_rate < 1
    ):
        reasons.append("safety check failed")
    return reasons


def _ratio(candidate, baseline):
    return (1 if candidate == 0 else inf) if baseline == 0 else candidate / baseline


def _validate_dataset(dataset):
    if not dataset:
        raise ValueError("Eval dataset 不能为空")
    ids = [case.id for case in dataset]
    if any(not item.strip() for item in ids) or len(ids) != len(set(ids)):
        raise ValueError("Eval case id 必须非空且唯一")
    if not any(case.split == "eval" for case in dataset):
        raise ValueError("Dataset 必须包含 eval split")
    if not any(case.split == "holdout" for case in dataset):
        raise ValueError("Dataset 必须包含 holdout split")
    if any(case.split not in {"eval", "holdout"} for case in dataset):
        raise ValueError("Eval split 只能是 eval 或 holdout")


def _validate_policy(policy):
    for value in (policy.min_eval_pass_rate, policy.min_holdout_pass_rate):
        if not isfinite(value) or not 0 <= value <= 1:
            raise ValueError("pass rate gate 必须位于 0 到 1")
    for value in (policy.min_eval_quality_delta, policy.min_holdout_quality_delta):
        if not isfinite(value) or not -1 <= value <= 1:
            raise ValueError("quality delta gate 必须位于 -1 到 1")
    for value in (
        policy.max_cost_increase_ratio, policy.max_latency_increase_ratio,
        policy.max_token_increase_ratio,
    ):
        if not isfinite(value) or value < 0:
            raise ValueError("resource ratio gate 必须是非负有限值")


def _validate_artifact(artifact):
    if not artifact.artifact_id.strip() or not artifact.content.strip():
        raise ValueError("Artifact id 和 content 不能为空")
    if not isinstance(artifact.version, int) or artifact.version <= 0:
        raise ValueError("Artifact version 必须是正整数")
    if artifact.kind not in {"prompt", "skill", "toolDescription", "routingPolicy"}:
        raise ValueError(f"不支持的 Artifact kind：{artifact.kind}")


def _now():
    return datetime.now(timezone.utc).isoformat()
