"""Evidence-first memory consolidation，源自 arXiv:2605.12978 的工程启发。"""

from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable


@dataclass(frozen=True)
class Episode:
    id: str
    scope: str
    task_id: str
    tags: tuple[str, ...]
    input: str
    trajectory: str
    outcome: str
    created_at: str


@dataclass(frozen=True)
class Applicability:
    all_tags: tuple[str, ...]
    none_tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class EvidenceLink:
    episode_id: str
    relation: str


@dataclass(frozen=True)
class ConsolidationReplayCase:
    id: str
    tags: tuple[str, ...]
    should_apply: bool
    baseline_passed: bool


@dataclass(frozen=True)
class ReplayResult:
    case_id: str
    applied: bool
    should_apply: bool
    baseline_passed: bool
    candidate_passed: bool


@dataclass(frozen=True)
class ConsolidationReport:
    passed: bool
    reasons: tuple[str, ...]
    supporting_episodes: int
    distinct_supporting_tasks: int
    counterexamples: int
    replay: tuple[ReplayResult, ...]


@dataclass(frozen=True)
class ConsolidationCandidate:
    id: str
    memory_id: str
    version: int
    scope: str
    lesson: str
    applicability: Applicability
    evidence: tuple[EvidenceLink, ...]
    rationale: str
    status: str
    created_at: str
    parent_version: int | None = None
    report: ConsolidationReport | None = None
    reviewed_by: str | None = None


@dataclass(frozen=True)
class ActiveMemory:
    memory_id: str
    version: int
    lesson: str
    scope: str
    source_episode_ids: tuple[str, ...]


@dataclass(frozen=True)
class ConsolidationRelease:
    action: str
    memory_id: str
    version: int
    actor: str
    timestamp: str


ConsolidationEvaluator = Callable[[ConsolidationCandidate, ConsolidationReplayCase], bool]


class GovernedMemoryBank:
    """原始 episode 不可覆盖；抽象 memory 必须经过回放 gate。"""

    def __init__(self) -> None:
        self._episodes: dict[str, Episode] = {}
        self._candidates: dict[str, ConsolidationCandidate] = {}
        self._active: dict[str, int] = {}
        self._releases: list[ConsolidationRelease] = []
        self._next_candidate = 1

    def retain(self, episode: Episode) -> None:
        _validate_episode(episode)
        existing = self._episodes.get(episode.id)
        if existing is not None and existing != episode:
            raise ValueError(f"Episode 不可覆盖：{episode.id}")
        self._episodes.setdefault(episode.id, deepcopy(episode))

    def propose(
        self, memory_id: str, scope: str, lesson: str,
        applicability: Applicability, evidence: list[EvidenceLink], rationale: str,
    ) -> ConsolidationCandidate:
        _validate_proposal(memory_id, scope, lesson, applicability, evidence, rationale)
        for link in evidence:
            if link.episode_id not in self._episodes:
                raise ValueError(f"未知 evidence episode：{link.episode_id}")
        versions = [item.version for item in self._candidates.values()
                    if item.memory_id == memory_id]
        candidate = ConsolidationCandidate(
            id=f"memory-candidate-{self._next_candidate}",
            memory_id=memory_id,
            version=max(versions, default=0) + 1,
            parent_version=self._active.get(memory_id),
            scope=scope,
            lesson=lesson,
            applicability=applicability,
            evidence=tuple(evidence),
            rationale=rationale,
            status="proposed",
            created_at=_now(),
        )
        self._next_candidate += 1
        self._candidates[candidate.id] = candidate
        return deepcopy(candidate)

    def evaluate(
        self, candidate_id: str, cases: list[ConsolidationReplayCase],
        evaluator: ConsolidationEvaluator, min_supporting_episodes: int = 2,
        min_distinct_tasks: int = 2, require_counterexample: bool = True,
        require_improvement: bool = True,
    ) -> ConsolidationCandidate:
        candidate = self._require_candidate(candidate_id)
        if candidate.status not in {"proposed", "evaluated"}:
            raise ValueError(f"当前状态不能评测：{candidate.status}")
        if not cases or len({case.id for case in cases}) != len(cases):
            raise ValueError("Replay cases 必须非空且 id 唯一")
        supports = [self._episodes[link.episode_id] for link in candidate.evidence
                    if link.relation == "support"]
        counters = [self._episodes[link.episode_id] for link in candidate.evidence
                    if link.relation == "counterexample"]
        distinct_tasks = len({episode.task_id for episode in supports})
        reasons: list[str] = []
        if len(supports) < min_supporting_episodes:
            reasons.append("not enough supporting episodes")
        if distinct_tasks < min_distinct_tasks:
            reasons.append("supporting evidence is too narrow")
        if require_counterexample and not counters:
            reasons.append("no counterexample defines the applicability boundary")
        if require_counterexample and not any(not case.should_apply for case in cases):
            reasons.append("replay set does not test an applicability boundary")
        if any(episode.scope != candidate.scope for episode in supports):
            reasons.append("supporting episodes mix different scopes")
        if any(not applies_to(candidate.applicability, episode.tags) for episode in supports):
            reasons.append("applicability excludes supporting evidence")
        if any(applies_to(candidate.applicability, episode.tags) for episode in counters):
            reasons.append("applicability still includes a counterexample")

        replay = []
        improvements = 0
        for case in cases:
            applied = applies_to(candidate.applicability, case.tags)
            candidate_passed = evaluator(candidate, case)
            if applied != case.should_apply:
                reasons.append(f"applicability mismatch: {case.id}")
            if case.baseline_passed and not candidate_passed:
                reasons.append(f"replay regression: {case.id}")
            if not case.baseline_passed and candidate_passed:
                improvements += 1
            replay.append(ReplayResult(
                case.id, applied, case.should_apply,
                case.baseline_passed, candidate_passed,
            ))
        if require_improvement and improvements == 0:
            reasons.append("candidate does not improve any replay case")
        report = ConsolidationReport(
            not reasons, tuple(dict.fromkeys(reasons)), len(supports),
            distinct_tasks, len(counters), tuple(replay),
        )
        updated = replace(candidate, status="evaluated", report=report)
        self._candidates[candidate_id] = updated
        return deepcopy(updated)

    def activate(self, candidate_id: str, actor: str) -> ConsolidationCandidate:
        candidate = self._require_candidate(candidate_id)
        if candidate.status != "evaluated" or not candidate.report or not candidate.report.passed:
            raise ValueError("只有通过 consolidation gate 的 candidate 才能激活")
        if not actor.strip():
            raise ValueError("actor 不能为空")
        if self._active.get(candidate.memory_id) != candidate.parent_version:
            raise ValueError("Active memory 已变化，请重新 propose/evaluate")
        self._supersede_active(candidate.memory_id)
        updated = replace(candidate, status="active", reviewed_by=actor)
        self._candidates[candidate_id] = updated
        self._active[candidate.memory_id] = candidate.version
        self._releases.append(ConsolidationRelease(
            "activate", candidate.memory_id, candidate.version, actor, _now()
        ))
        return deepcopy(updated)

    def reject(self, candidate_id: str, actor: str) -> ConsolidationCandidate:
        candidate = self._require_candidate(candidate_id)
        if candidate.status == "active":
            raise ValueError("Active memory 必须 rollback，不能 reject")
        if not actor.strip():
            raise ValueError("actor 不能为空")
        updated = replace(candidate, status="rejected", reviewed_by=actor)
        self._candidates[candidate_id] = updated
        return deepcopy(updated)

    def rollback(self, memory_id: str, version: int, actor: str) -> ConsolidationCandidate:
        if not actor.strip():
            raise ValueError("actor 不能为空")
        target = next((item for item in self._candidates.values()
                       if item.memory_id == memory_id and item.version == version
                       and item.report and item.report.passed), None)
        if target is None:
            raise ValueError(f"未知 gated memory version：{memory_id}@{version}")
        if not any(item.memory_id == memory_id and item.version == version
                   for item in self._releases):
            raise ValueError("Rollback target 从未激活")
        self._supersede_active(memory_id)
        updated = replace(target, status="active", reviewed_by=actor)
        self._candidates[target.id] = updated
        self._active[memory_id] = version
        self._releases.append(ConsolidationRelease(
            "rollback", memory_id, version, actor, _now()
        ))
        return deepcopy(updated)

    def active(self, tags: tuple[str, ...] | list[str]) -> list[ActiveMemory]:
        result = []
        for memory_id, version in self._active.items():
            candidate = next(item for item in self._candidates.values()
                             if item.memory_id == memory_id and item.version == version)
            if applies_to(candidate.applicability, tags):
                result.append(ActiveMemory(
                    memory_id, version, candidate.lesson, candidate.scope,
                    tuple(link.episode_id for link in candidate.evidence),
                ))
        return result

    def get_episode(self, episode_id: str) -> Episode | None:
        return deepcopy(self._episodes.get(episode_id))

    def get_candidate(self, candidate_id: str) -> ConsolidationCandidate | None:
        return deepcopy(self._candidates.get(candidate_id))

    def release_history(self) -> list[ConsolidationRelease]:
        return deepcopy(self._releases)

    def _require_candidate(self, candidate_id: str) -> ConsolidationCandidate:
        if candidate_id not in self._candidates:
            raise ValueError(f"未知 consolidation candidate：{candidate_id}")
        return self._candidates[candidate_id]

    def _supersede_active(self, memory_id: str) -> None:
        for candidate_id, candidate in list(self._candidates.items()):
            if candidate.memory_id == memory_id and candidate.status == "active":
                self._candidates[candidate_id] = replace(candidate, status="superseded")


def applies_to(applicability: Applicability, tags: tuple[str, ...] | list[str]) -> bool:
    available = set(tags)
    return all(tag in available for tag in applicability.all_tags) and not any(
        tag in available for tag in applicability.none_tags
    )


def apply_governed_memories_to_prompt(
    base_prompt: str, memories: list[ActiveMemory]
) -> str:
    if not memories:
        return base_prompt
    entries = "\n".join(_render_active_memory(item) for item in memories)
    return f"{base_prompt}\n\n# Gated memories\n\n{entries}"


def _validate_episode(episode: Episode) -> None:
    if not episode.id or not episode.scope or not episode.task_id:
        raise ValueError("Episode id、scope、task_id 不能为空")
    if not episode.tags or not episode.input.strip() or not episode.trajectory.strip():
        raise ValueError("Episode tags、input、trajectory 不能为空")
    if any(not tag.strip() for tag in episode.tags):
        raise ValueError("Episode tag 不能为空")
    if episode.outcome not in {"success", "failure"}:
        raise ValueError("Episode outcome 无效")


def _validate_proposal(
    memory_id: str, scope: str, lesson: str, applicability: Applicability,
    evidence: list[EvidenceLink], rationale: str,
) -> None:
    if not memory_id or not scope or not lesson.strip() or not rationale.strip() or not evidence:
        raise ValueError("Proposal 字段不能为空")
    if not applicability.all_tags:
        raise ValueError("至少需要一个 applicability tag")
    if set(applicability.all_tags) & set(applicability.none_tags):
        raise ValueError("同一 tag 不能同时 required 和 excluded")
    if len({item.episode_id for item in evidence}) != len(evidence):
        raise ValueError("Evidence episode id 必须唯一")
    if any(item.relation not in {"support", "counterexample"} for item in evidence):
        raise ValueError("Evidence relation 无效")


def _escape(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def _render_active_memory(item: ActiveMemory) -> str:
    sources = ",".join(_escape(source) for source in item.source_episode_ids)
    return (
        f'<governed_memory id="{_escape(item.memory_id)}" version="{item.version}" '
        f'scope="{_escape(item.scope)}" sources="{sources}">'
        f'{_escape(item.lesson)}</governed_memory>'
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
