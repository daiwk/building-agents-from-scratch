"""AIDE² + RRSI 启发的受控递归自我改进教学实现。"""

from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from math import ceil, cos, isfinite, pi
from typing import Callable


COMPONENTS = (
    "prompt", "control_flow", "config", "output_plumbing", "context_management",
    "client_tool", "skill", "memory", "subagent",
)


@dataclass(frozen=True)
class AtomicHarnessEdit:
    id: str
    component: str
    operation: str
    hypothesis: str
    description: str
    source_diff: str


@dataclass(frozen=True)
class HarnessGrade:
    public_score: float
    selection_score: float
    policy_tokens: int
    safety_passed: bool


@dataclass(frozen=True)
class PublicHarnessGrade:
    public_score: float
    policy_tokens: int
    safety_passed: bool


@dataclass(frozen=True)
class HarnessVersion:
    id: str
    version: int
    content: str
    created_at: str
    parent_version: int | None = None


@dataclass(frozen=True)
class RsiSelection:
    admissible: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class RsiCandidate:
    id: str
    round: int
    harness: HarnessVersion
    edits: tuple[AtomicHarnessEdit, ...]
    status: str
    screen_reasons: tuple[str, ...]
    grade: PublicHarnessGrade | None = None
    selection: RsiSelection | None = None


@dataclass(frozen=True)
class EditHistoryRecord:
    round: int
    candidate_id: str
    component: str
    hypothesis: str
    source_diff: str
    public_score_delta: float
    cost_delta_ratio: float
    accepted: bool


@dataclass(frozen=True)
class RsiPolicy:
    total_rounds: int = 8
    min_edit_budget: int = 1
    max_edit_budget: int = 4
    noise_band: float = 0.02
    max_policy_tokens: int = 100_000
    base_cost_allowance: float = 0.05
    cost_per_score_gain: float = 1.0
    within_band_score_weight: float = 1.0
    within_band_cost_weight: float = 0.25
    within_band_novelty_weight: float = 0.02
    stall_window: int = 2
    prune_window: int = 3


@dataclass(frozen=True)
class RsiProposalContext:
    round: int
    incumbent: HarnessVersion
    edit_budget: int
    stalled: bool
    underexplored_components: tuple[str, ...]
    pruning_targets: tuple[str, ...]
    # 不包含 selection_score、私有 case、答案或 verifier 输出。
    evidence: tuple[EditHistoryRecord, ...]


HarnessGrader = Callable[[HarnessVersion], HarnessGrade]


class RegularizedRsiController:
    """固定 selector 管理 lineage；模型只能提供 content 与 atomic edits。"""

    def __init__(
        self,
        initial: HarnessVersion,
        initial_grade: HarnessGrade,
        grader: HarnessGrader,
        policy: RsiPolicy | None = None,
        protected_terms: tuple[str, ...] = (),
    ) -> None:
        self.policy = policy or RsiPolicy()
        _validate_policy(self.policy)
        _validate_harness(initial)
        _validate_grade(initial_grade)
        if initial.parent_version is not None:
            raise ValueError("Initial harness 不能有 parent")
        self.grader = grader
        self.protected_terms = tuple(term.lower() for term in protected_terms if term.strip())
        self._candidates: dict[str, RsiCandidate] = {}
        self._versions = {initial.version: deepcopy(initial)}
        self._grades = {initial.version: deepcopy(initial_grade)}
        self._candidate_grades: dict[str, HarnessGrade] = {}
        self._history: list[EditHistoryRecord] = []
        self._releases: list[dict[str, str | int]] = []
        self._round = 0
        self._active_version = initial.version
        self._best_selection_score = initial_grade.selection_score
        self._next_candidate = 1

    def edit_budget(self, round_number: int | None = None) -> int:
        current = self._round if round_number is None else round_number
        if not isinstance(current, int) or current < 0:
            raise ValueError("RSI round 必须是非负整数")
        progress = min(current, self.policy.total_rounds) / self.policy.total_rounds
        return ceil(
            self.policy.min_edit_budget
            + (self.policy.max_edit_budget - self.policy.min_edit_budget)
            * 0.5 * (1 + cos(pi * progress))
        )

    def proposal_context(self) -> RsiProposalContext:
        touched = {item.component for item in self._history}
        return RsiProposalContext(
            self._round,
            self.incumbent(),
            self.edit_budget(),
            self._is_stalled(),
            tuple(component for component in COMPONENTS if component not in touched),
            self._pruning_targets(),
            tuple(deepcopy(self._history)),
        )

    def propose(self, content: str, edits: list[AtomicHarnessEdit]) -> RsiCandidate:
        if self._round >= self.policy.total_rounds:
            raise ValueError("RSI run 已达到 round 上限")
        _validate_edits(edits)
        if len(edits) > self.edit_budget():
            raise ValueError(f"Candidate 超过退火 edit budget {self.edit_budget()}")
        incumbent = self.incumbent()
        reasons = self._screen(edits)
        candidate = RsiCandidate(
            f"rsi-candidate-{self._next_candidate}",
            self._round,
            HarnessVersion(
                incumbent.id, max(self._versions) + 1, content, _now(), incumbent.version
            ),
            tuple(deepcopy(edits)),
            "screened_out" if reasons else "proposed",
            reasons,
        )
        _validate_harness(candidate.harness)
        self._next_candidate += 1
        self._candidates[candidate.id] = candidate
        return deepcopy(candidate)

    def evaluate(self, candidate_id: str) -> RsiCandidate:
        candidate = self._require_candidate(candidate_id)
        if candidate.status == "screened_out":
            raise ValueError("Screened candidate 不能消耗评测预算")
        if candidate.status not in {"proposed", "evaluated"}:
            raise ValueError(f"当前状态不能评测：{candidate.status}")
        self._require_current_parent(candidate)
        grade = self.grader(deepcopy(candidate.harness))
        _validate_grade(grade)
        self._candidate_grades[candidate_id] = deepcopy(grade)
        updated = replace(
            candidate,
            status="evaluated",
            grade=PublicHarnessGrade(
                grade.public_score, grade.policy_tokens, grade.safety_passed
            ),
            selection=self._selectability(candidate, grade),
        )
        self._candidates[candidate_id] = updated
        return deepcopy(updated)

    def select(self, candidate_ids: list[str], actor: str) -> HarnessVersion:
        if not actor.strip():
            raise ValueError("selection actor 不能为空")
        if not candidate_ids or len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("Selection 需要唯一 candidate ids")
        expected = [candidate.id for candidate in self._candidates.values()
                    if candidate.round == self._round
                    and candidate.harness.parent_version == self._active_version]
        if len(expected) != len(candidate_ids) or any(
                identifier not in candidate_ids for identifier in expected):
            raise ValueError("Selection 必须包含当前 round 的全部 candidates")
        candidates = [self._require_candidate(identifier) for identifier in candidate_ids]
        for candidate in candidates:
            if candidate.round != self._round or candidate.harness.parent_version != self._active_version:
                raise ValueError("Candidate 属于过期 RSI round")
            if candidate.status not in {"evaluated", "screened_out"}:
                raise ValueError("Candidate 必须先 screen 或 evaluate")
        admissible = [candidate for candidate in candidates
                      if candidate.status == "evaluated" and candidate.selection
                      and candidate.selection.admissible and candidate.grade]
        winner = max(
            admissible,
            key=lambda item: self._candidate_grades[item.id].selection_score,
            default=None,
        )
        for candidate in candidates:
            accepted = winner is not None and candidate.id == winner.id
            self._candidates[candidate.id] = replace(
                candidate, status="accepted" if accepted else "rejected"
            )
            if candidate.grade:
                self._record_evidence(candidate, accepted)
        winner_grade = self._candidate_grades.get(winner.id) if winner else None
        if winner and winner.grade and winner_grade:
            self._versions[winner.harness.version] = deepcopy(winner.harness)
            self._grades[winner.harness.version] = deepcopy(winner_grade)
            self._active_version = winner.harness.version
            self._best_selection_score = max(
                self._best_selection_score, winner_grade.selection_score
            )
            self._releases.append({
                "action": "accept", "version": winner.harness.version, "actor": actor
            })
        self._round += 1
        return self.incumbent()

    def rollback(self, version: int, actor: str) -> HarnessVersion:
        if not actor.strip():
            raise ValueError("rollback actor 不能为空")
        initial_version = min(self._versions)
        was_accepted = any(
            item["action"] == "accept" and item["version"] == version
            for item in self._releases
        )
        if version != initial_version and not was_accepted:
            raise ValueError("Rollback target 从未成为 accepted incumbent")
        if version not in self._versions:
            raise ValueError(f"未知 harness version：{version}")
        self._active_version = version
        self._releases.append({"action": "rollback", "version": version, "actor": actor})
        return self.incumbent()

    def incumbent(self) -> HarnessVersion:
        return deepcopy(self._versions[self._active_version])

    def lineage(self) -> list[HarnessVersion]:
        return [deepcopy(self._versions[key]) for key in sorted(self._versions)]

    def edit_history(self) -> list[EditHistoryRecord]:
        return deepcopy(self._history)

    def release_history(self) -> list[dict[str, str | int]]:
        return deepcopy(self._releases)

    def _screen(self, edits: list[AtomicHarnessEdit]) -> tuple[str, ...]:
        reasons = []
        for edit in edits:
            text = f"{edit.description}\n{edit.source_diff}".lower()
            if any(term in text for term in self.protected_terms):
                reasons.append(f"possible benchmark leakage in edit {edit.id}")
            if not edit.source_diff.strip():
                reasons.append(f"inert edit {edit.id}")
        return tuple(dict.fromkeys(reasons))

    def _selectability(self, candidate: RsiCandidate, grade: HarnessGrade) -> RsiSelection:
        parent = self._grades[candidate.harness.parent_version]
        score_delta = grade.selection_score - parent.selection_score
        cost_delta = _ratio_delta(grade.policy_tokens, parent.policy_tokens)
        touched = {item.component for item in self._history}
        novelty = len({edit.component for edit in candidate.edits if edit.component not in touched})
        reasons = []
        if not grade.safety_passed:
            reasons.append("safety gate failed")
        if grade.policy_tokens > self.policy.max_policy_tokens:
            reasons.append("fixed policy-token budget exceeded")
        if grade.selection_score < self._best_selection_score - self.policy.noise_band:
            reasons.append("selection score is below the noise-adjusted floor")
        if score_delta > self.policy.noise_band:
            allowance = self.policy.base_cost_allowance + self.policy.cost_per_score_gain * score_delta
            if cost_delta > allowance:
                reasons.append("cost growth is not justified by score gain")
        else:
            shaped = (
                self.policy.within_band_score_weight * score_delta
                - self.policy.within_band_cost_weight * cost_delta
                + self.policy.within_band_novelty_weight * novelty
            )
            if shaped <= 0:
                reasons.append("within-noise candidate has no efficiency or novelty benefit")
        return RsiSelection(not reasons, tuple(reasons))

    def _record_evidence(self, candidate: RsiCandidate, accepted: bool) -> None:
        parent = self._grades[candidate.harness.parent_version]
        for edit in candidate.edits:
            self._history.append(EditHistoryRecord(
                self._round, candidate.id, edit.component, edit.hypothesis, edit.source_diff,
                candidate.grade.public_score - parent.public_score,
                _ratio_delta(candidate.grade.policy_tokens, parent.policy_tokens), accepted,
            ))

    def _pruning_targets(self) -> tuple[str, ...]:
        from_round = max(0, self._round - self.policy.prune_window)
        targets = []
        for component in COMPONENTS:
            recent = [item.public_score_delta for item in self._history
                      if item.component == component and item.round >= from_round]
            if recent and max(recent) <= 0:
                targets.append(component)
        return tuple(targets)

    def _is_stalled(self) -> bool:
        scores = [self._grades[key].public_score for key in sorted(self._grades)]
        if len(scores) <= self.policy.stall_window:
            return False
        return scores[-1] - scores[-(self.policy.stall_window + 1)] <= self.policy.noise_band

    def _require_candidate(self, candidate_id: str) -> RsiCandidate:
        if candidate_id not in self._candidates:
            raise ValueError(f"未知 RSI candidate：{candidate_id}")
        return deepcopy(self._candidates[candidate_id])

    def _require_current_parent(self, candidate: RsiCandidate) -> None:
        if candidate.round != self._round or candidate.harness.parent_version != self._active_version:
            raise ValueError("Candidate parent 已不是 active incumbent")


def calibrate_noise_band(scores: list[float]) -> float:
    if len(scores) < 2 or any(not isfinite(score) for score in scores):
        raise ValueError("Noise calibration 至少需要两个有限分数")
    return max(scores) - min(scores)


def _validate_policy(policy: RsiPolicy) -> None:
    if not all(isinstance(value, int) for value in (
        policy.total_rounds, policy.min_edit_budget, policy.max_edit_budget,
        policy.max_policy_tokens, policy.stall_window, policy.prune_window,
    )) or policy.total_rounds <= 0 or policy.min_edit_budget <= 0 \
            or policy.max_edit_budget < policy.min_edit_budget:
        raise ValueError("RSI round/edit budget policy 无效")
    numeric = (
        policy.noise_band, policy.max_policy_tokens, policy.base_cost_allowance,
        policy.cost_per_score_gain, policy.within_band_score_weight,
        policy.within_band_cost_weight, policy.within_band_novelty_weight,
    )
    if any(not isfinite(value) or value < 0 for value in numeric):
        raise ValueError("RSI policy 必须是非负有限数")
    if policy.stall_window <= 0 or policy.prune_window <= 0:
        raise ValueError("RSI history window 无效")


def _validate_harness(harness: HarnessVersion) -> None:
    if not harness.id.strip() or not harness.content.strip() or harness.version <= 0:
        raise ValueError("Harness id、content、positive version 不能为空")
    try:
        datetime.fromisoformat(harness.created_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Harness created_at 无效") from error


def _validate_grade(grade: HarnessGrade) -> None:
    if any(not isfinite(score) or score < 0 or score > 1
           for score in (grade.public_score, grade.selection_score)):
        raise ValueError("Harness score 必须在 [0, 1]")
    if not isfinite(grade.policy_tokens) or grade.policy_tokens < 0:
        raise ValueError("policy token cost 无效")


def _validate_edits(edits: list[AtomicHarnessEdit]) -> None:
    if not edits or len({edit.id for edit in edits}) != len(edits):
        raise ValueError("Atomic edits 必须非空且 id 唯一")
    for edit in edits:
        if not edit.id.strip() or edit.component not in COMPONENTS \
                or edit.operation not in {"add", "update", "remove"} \
                or not edit.hypothesis.strip() or not edit.description.strip():
            raise ValueError(f"Atomic edit 无效：{edit.id}")


def _ratio_delta(candidate: float, baseline: float) -> float:
    if baseline == 0:
        return 0 if candidate == 0 else float("inf")
    return (candidate - baseline) / baseline


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
