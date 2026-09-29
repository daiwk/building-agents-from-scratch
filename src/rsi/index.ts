/**
 * Stage 17：受 AIDE²（arXiv:2609.26457）与 RRSI（arXiv:2609.24972）启发的
 * regularized recursive self-improvement 教学实现。
 *
 * “递归”只表示：本轮通过 gate 的 harness 会成为下一轮的 parent。
 * 模型不能修改这段 selector、评测集、预算或人工审批边界。
 */

export type HarnessComponent =
  | "prompt"
  | "control_flow"
  | "config"
  | "output_plumbing"
  | "context_management"
  | "client_tool"
  | "skill"
  | "memory"
  | "subagent";

export type AtomicHarnessEdit = {
  id: string;
  component: HarnessComponent;
  operation: "add" | "update" | "remove";
  hypothesis: string;
  description: string;
  /** 教学版只保存 diff 作为审计证据，不在 selector 内执行任意代码。 */
  sourceDiff: string;
};

export type HarnessGrade = {
  /** 可反馈给 proposer 的 evolve-set 聚合分数。 */
  publicScore: number;
  /** 只供固定 selector 使用的私有聚合分数，不进入 proposalContext。 */
  selectionScore: number;
  policyTokens: number;
  safetyPassed: boolean;
};

export type PublicHarnessGrade = Omit<HarnessGrade, "selectionScore">;

export type HarnessVersion = {
  id: string;
  version: number;
  parentVersion?: number;
  content: string;
  createdAt: string;
};

export type RsiCandidate = {
  id: string;
  round: number;
  harness: HarnessVersion;
  edits: AtomicHarnessEdit[];
  status: "proposed" | "screened_out" | "evaluated" | "accepted" | "rejected";
  screenReasons: string[];
  grade?: PublicHarnessGrade;
  selection?: { admissible: boolean; reasons: string[] };
};

export type EditHistoryRecord = {
  round: number;
  candidateId: string;
  component: HarnessComponent;
  hypothesis: string;
  sourceDiff: string;
  publicScoreDelta: number;
  costDeltaRatio: number;
  accepted: boolean;
};

export type RsiPolicy = {
  totalRounds: number;
  minEditBudget: number;
  maxEditBudget: number;
  noiseBand: number;
  maxPolicyTokens: number;
  baseCostAllowance: number;
  costPerScoreGain: number;
  withinBandScoreWeight: number;
  withinBandCostWeight: number;
  withinBandNoveltyWeight: number;
  stallWindow: number;
  pruneWindow: number;
};

export const DEFAULT_RSI_POLICY: RsiPolicy = Object.freeze({
  totalRounds: 8,
  minEditBudget: 1,
  maxEditBudget: 4,
  noiseBand: 0.02,
  maxPolicyTokens: 100_000,
  baseCostAllowance: 0.05,
  costPerScoreGain: 1,
  withinBandScoreWeight: 1,
  withinBandCostWeight: 0.25,
  withinBandNoveltyWeight: 0.02,
  stallWindow: 2,
  pruneWindow: 3,
});

export type RsiProposalContext = {
  round: number;
  incumbent: HarnessVersion;
  editBudget: number;
  stalled: boolean;
  underexploredComponents: HarnessComponent[];
  pruningTargets: HarnessComponent[];
  /** 不含 selectionScore、私有 case、答案或 verifier 输出。 */
  evidence: EditHistoryRecord[];
};

export type HarnessGrader = (
  harness: Readonly<HarnessVersion>,
) => HarnessGrade | Promise<HarnessGrade>;

const COMPONENTS: readonly HarnessComponent[] = [
  "prompt", "control_flow", "config", "output_plumbing", "context_management",
  "client_tool", "skill", "memory", "subagent",
];

export class RegularizedRsiController {
  private readonly candidates = new Map<string, RsiCandidate>();
  private readonly versions = new Map<number, HarnessVersion>();
  private readonly grades = new Map<number, HarnessGrade>();
  private readonly candidateGrades = new Map<string, HarnessGrade>();
  private readonly history: EditHistoryRecord[] = [];
  private readonly releases: Array<{ action: "accept" | "rollback"; version: number; actor: string }> = [];
  private readonly policy: RsiPolicy;
  private round = 0;
  private activeVersion: number;
  private bestSelectionScore: number;
  private nextCandidate = 1;

  constructor(
    initial: HarnessVersion,
    initialGrade: HarnessGrade,
    private readonly grader: HarnessGrader,
    policy: Partial<RsiPolicy> = {},
    private readonly protectedTerms: readonly string[] = [],
  ) {
    this.policy = { ...DEFAULT_RSI_POLICY, ...policy };
    validatePolicy(this.policy);
    validateHarness(initial);
    validateGrade(initialGrade);
    if (initial.parentVersion !== undefined) throw new Error("Initial harness cannot have a parent.");
    this.versions.set(initial.version, structuredClone(initial));
    this.grades.set(initial.version, structuredClone(initialGrade));
    this.activeVersion = initial.version;
    this.bestSelectionScore = initialGrade.selectionScore;
  }

  /** RRSI 的 cosine annealing：前期允许组合探索，后期强制更稀疏、可归因的修改。 */
  editBudget(round = this.round): number {
    if (!Number.isInteger(round) || round < 0) throw new Error("RSI round must be a non-negative integer.");
    const progress = Math.min(round, this.policy.totalRounds) / this.policy.totalRounds;
    return Math.ceil(this.policy.minEditBudget +
      (this.policy.maxEditBudget - this.policy.minEditBudget) * 0.5 * (1 + Math.cos(Math.PI * progress)));
  }

  proposalContext(): RsiProposalContext {
    const touched = new Set(this.history.map((item) => item.component));
    return {
      round: this.round,
      incumbent: this.incumbent(),
      editBudget: this.editBudget(),
      stalled: this.isStalled(),
      underexploredComponents: COMPONENTS.filter((item) => !touched.has(item)),
      pruningTargets: this.pruningTargets(),
      evidence: structuredClone(this.history),
    };
  }

  propose(content: string, edits: readonly AtomicHarnessEdit[]): RsiCandidate {
    if (this.round >= this.policy.totalRounds) throw new Error("RSI run reached its round limit.");
    validateEdits(edits);
    if (edits.length > this.editBudget()) {
      throw new Error(`Candidate exceeds annealed edit budget ${this.editBudget()}.`);
    }
    const incumbent = this.incumbent();
    const candidate: RsiCandidate = {
      id: `rsi-candidate-${this.nextCandidate++}`,
      round: this.round,
      harness: {
        id: incumbent.id,
        version: Math.max(...this.versions.keys()) + 1,
        parentVersion: incumbent.version,
        content,
        createdAt: new Date().toISOString(),
      },
      edits: structuredClone([...edits]),
      status: "proposed",
      screenReasons: this.screen(edits),
    };
    validateHarness(candidate.harness);
    if (candidate.screenReasons.length > 0) candidate.status = "screened_out";
    this.candidates.set(candidate.id, candidate);
    return structuredClone(candidate);
  }

  async evaluate(candidateId: string): Promise<RsiCandidate> {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status === "screened_out") throw new Error("Screened candidate cannot consume evaluation budget.");
    if (candidate.status !== "proposed" && candidate.status !== "evaluated") {
      throw new Error(`Candidate cannot be evaluated from ${candidate.status}.`);
    }
    this.requireCurrentParent(candidate);
    const grade = await this.grader(structuredClone(candidate.harness));
    validateGrade(grade);
    this.candidateGrades.set(candidateId, structuredClone(grade));
    const selection = this.selectability(candidate, grade);
    const updated: RsiCandidate = {
      ...candidate,
      status: "evaluated",
      grade: {
        publicScore: grade.publicScore,
        policyTokens: grade.policyTokens,
        safetyPassed: grade.safetyPassed,
      },
      selection,
    };
    this.candidates.set(candidateId, updated);
    return structuredClone(updated);
  }

  /** 固定 selector 选择 admissible candidate；没有候选通过时，incumbent 原地保留。 */
  select(candidateIds: readonly string[], actor: string): HarnessVersion {
    if (!actor.trim()) throw new Error("Selection actor is required.");
    if (candidateIds.length === 0 || new Set(candidateIds).size !== candidateIds.length) {
      throw new Error("Selection needs unique candidate ids.");
    }
    const expected = [...this.candidates.values()]
      .filter((item) => item.round === this.round && item.harness.parentVersion === this.activeVersion)
      .map((item) => item.id);
    if (expected.length !== candidateIds.length || expected.some((id) => !candidateIds.includes(id))) {
      throw new Error("Selection must include every candidate from the current round.");
    }
    const candidates = candidateIds.map((id) => this.requireCandidate(id));
    for (const candidate of candidates) {
      if (candidate.round !== this.round || candidate.harness.parentVersion !== this.activeVersion) {
        throw new Error("Candidate belongs to a stale RSI round.");
      }
      if (candidate.status !== "evaluated" && candidate.status !== "screened_out") {
        throw new Error("Every candidate must be screened or evaluated before selection.");
      }
    }
    const winner = candidates
      .filter((item) => item.status === "evaluated" && item.selection?.admissible && item.grade)
      .sort((left, right) =>
        this.candidateGrades.get(right.id)!.selectionScore -
        this.candidateGrades.get(left.id)!.selectionScore
      )[0];

    for (const candidate of candidates) {
      const accepted = candidate.id === winner?.id;
      this.candidates.set(candidate.id, {
        ...candidate,
        status: accepted ? "accepted" : "rejected",
      });
      if (candidate.grade) this.recordEvidence(candidate, accepted);
    }
    const winnerGrade = winner ? this.candidateGrades.get(winner.id) : undefined;
    if (winner?.grade && winnerGrade) {
      this.versions.set(winner.harness.version, structuredClone(winner.harness));
      this.grades.set(winner.harness.version, structuredClone(winnerGrade));
      this.activeVersion = winner.harness.version;
      this.bestSelectionScore = Math.max(this.bestSelectionScore, winnerGrade.selectionScore);
      this.releases.push({ action: "accept", version: winner.harness.version, actor });
    }
    this.round += 1;
    return this.incumbent();
  }

  rollback(version: number, actor: string): HarnessVersion {
    if (!actor.trim()) throw new Error("Rollback actor is required.");
    if (!this.releases.some((item) => item.action === "accept" && item.version === version) &&
      version !== Math.min(...this.versions.keys())) {
      throw new Error("Rollback target was never an accepted incumbent.");
    }
    if (!this.versions.has(version)) throw new Error(`Unknown harness version: ${version}.`);
    this.activeVersion = version;
    this.releases.push({ action: "rollback", version, actor });
    return this.incumbent();
  }

  incumbent(): HarnessVersion {
    return structuredClone(this.versions.get(this.activeVersion)!);
  }

  lineage(): HarnessVersion[] {
    return [...this.versions.values()]
      .sort((a, b) => a.version - b.version)
      .map((item) => structuredClone(item));
  }

  editHistory(): EditHistoryRecord[] {
    return structuredClone(this.history);
  }

  releaseHistory() {
    return structuredClone(this.releases);
  }

  private screen(edits: readonly AtomicHarnessEdit[]): string[] {
    const reasons: string[] = [];
    const protectedTerms = this.protectedTerms.map((item) => item.trim().toLowerCase()).filter(Boolean);
    for (const edit of edits) {
      const text = `${edit.description}\n${edit.sourceDiff}`.toLowerCase();
      if (protectedTerms.some((term) => text.includes(term))) {
        reasons.push(`possible benchmark leakage in edit ${edit.id}`);
      }
      if (!edit.sourceDiff.trim()) reasons.push(`inert edit ${edit.id}`);
    }
    return [...new Set(reasons)];
  }

  private selectability(candidate: RsiCandidate, grade: HarnessGrade) {
    const parentGrade = this.grades.get(candidate.harness.parentVersion!)!;
    const scoreDelta = grade.selectionScore - parentGrade.selectionScore;
    const costDelta = ratioDelta(grade.policyTokens, parentGrade.policyTokens);
    const touched = new Set(this.history.map((item) => item.component));
    const novelty = new Set(candidate.edits.filter((item) => !touched.has(item.component)).map((item) => item.component)).size;
    const reasons: string[] = [];
    if (!grade.safetyPassed) reasons.push("safety gate failed");
    if (grade.policyTokens > this.policy.maxPolicyTokens) reasons.push("fixed policy-token budget exceeded");
    if (grade.selectionScore < this.bestSelectionScore - this.policy.noiseBand) {
      reasons.push("selection score is below the noise-adjusted floor");
    }
    if (scoreDelta > this.policy.noiseBand) {
      if (costDelta > this.policy.baseCostAllowance + this.policy.costPerScoreGain * scoreDelta) {
        reasons.push("cost growth is not justified by score gain");
      }
    } else {
      const shaped = this.policy.withinBandScoreWeight * scoreDelta -
        this.policy.withinBandCostWeight * costDelta +
        this.policy.withinBandNoveltyWeight * novelty;
      if (shaped <= 0) reasons.push("within-noise candidate has no efficiency or novelty benefit");
    }
    return { admissible: reasons.length === 0, reasons };
  }

  private recordEvidence(candidate: RsiCandidate, accepted: boolean): void {
    const parentGrade = this.grades.get(candidate.harness.parentVersion!)!;
    for (const edit of candidate.edits) {
      this.history.push({
        round: this.round,
        candidateId: candidate.id,
        component: edit.component,
        hypothesis: edit.hypothesis,
        sourceDiff: edit.sourceDiff,
        publicScoreDelta: candidate.grade!.publicScore - parentGrade.publicScore,
        costDeltaRatio: ratioDelta(candidate.grade!.policyTokens, parentGrade.policyTokens),
        accepted,
      });
    }
  }

  private pruningTargets(): HarnessComponent[] {
    const fromRound = Math.max(0, this.round - this.policy.pruneWindow);
    return COMPONENTS.filter((component) => {
      const recent = this.history.filter((item) => item.component === component && item.round >= fromRound);
      return recent.length > 0 && Math.max(...recent.map((item) => item.publicScoreDelta)) <= 0;
    });
  }

  private isStalled(): boolean {
    const grades = [...this.grades.entries()].sort((a, b) => a[0] - b[0]).map((item) => item[1].publicScore);
    if (grades.length <= this.policy.stallWindow) return false;
    return grades.at(-1)! - grades.at(-(this.policy.stallWindow + 1))! <= this.policy.noiseBand;
  }

  private requireCandidate(id: string): RsiCandidate {
    const candidate = this.candidates.get(id);
    if (!candidate) throw new Error(`Unknown RSI candidate: ${id}.`);
    return structuredClone(candidate);
  }

  private requireCurrentParent(candidate: RsiCandidate): void {
    if (candidate.round !== this.round || candidate.harness.parentVersion !== this.activeVersion) {
      throw new Error("Candidate parent is no longer the active incumbent.");
    }
  }
}

/** 用重复运行基线的最大波动估计保守噪声带。 */
export function calibrateNoiseBand(scores: readonly number[]): number {
  if (scores.length < 2 || scores.some((score) => !Number.isFinite(score))) {
    throw new Error("Noise calibration needs at least two finite scores.");
  }
  return Math.max(...scores) - Math.min(...scores);
}

function validatePolicy(policy: RsiPolicy): void {
  if (!Number.isInteger(policy.totalRounds) || policy.totalRounds <= 0 ||
    !Number.isInteger(policy.minEditBudget) || policy.minEditBudget <= 0 ||
    !Number.isInteger(policy.maxEditBudget) || policy.maxEditBudget < policy.minEditBudget) {
    throw new Error("Invalid RSI round or edit-budget policy.");
  }
  for (const value of [policy.noiseBand, policy.maxPolicyTokens, policy.baseCostAllowance,
    policy.costPerScoreGain, policy.withinBandScoreWeight, policy.withinBandCostWeight,
    policy.withinBandNoveltyWeight]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid non-negative RSI policy value.");
  }
  if (!Number.isInteger(policy.stallWindow) || policy.stallWindow <= 0 ||
    !Number.isInteger(policy.pruneWindow) || policy.pruneWindow <= 0) {
    throw new Error("Invalid RSI history window.");
  }
}

function validateHarness(harness: HarnessVersion): void {
  if (!harness.id.trim() || !harness.content.trim() || !Number.isInteger(harness.version) || harness.version <= 0) {
    throw new Error("Harness id, content and positive version are required.");
  }
  if (!Number.isFinite(Date.parse(harness.createdAt))) throw new Error("Invalid harness createdAt.");
}

function validateGrade(grade: HarnessGrade): void {
  for (const score of [grade.publicScore, grade.selectionScore]) {
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("Harness scores must be in [0, 1].");
  }
  if (!Number.isFinite(grade.policyTokens) || grade.policyTokens < 0) throw new Error("Invalid policy-token cost.");
}

function validateEdits(edits: readonly AtomicHarnessEdit[]): void {
  if (edits.length === 0 || new Set(edits.map((item) => item.id)).size !== edits.length) {
    throw new Error("Atomic edits must be non-empty and have unique ids.");
  }
  for (const edit of edits) {
    if (!edit.id.trim() || !COMPONENTS.includes(edit.component) ||
      !["add", "update", "remove"].includes(edit.operation) ||
      !edit.hypothesis.trim() || !edit.description.trim()) {
      throw new Error(`Invalid atomic edit: ${edit.id}.`);
    }
  }
}

function ratioDelta(candidate: number, baseline: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (candidate - baseline) / baseline;
}
