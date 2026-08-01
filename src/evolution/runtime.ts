import type {
  ArtifactEvaluator,
  ArtifactKind,
  ArtifactStore,
  ArtifactVersion,
  EvalCase,
  EvalMetrics,
  EvalSampleResult,
  EvaluationReport,
  EvolutionCandidate,
  GatePolicy,
  MonitoringRecord,
  ReleaseRecord,
} from "./types.js";

/** 内存教学实现；生产环境可在 ArtifactStore 边界换成数据库或制品仓库。 */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly versions = new Map<string, Map<number, ArtifactVersion>>();
  private readonly activeVersions = new Map<string, number>();

  put(artifact: ArtifactVersion): void {
    validateArtifact(artifact);
    const versions = this.versions.get(artifact.artifactId) ?? new Map();
    if (versions.has(artifact.version)) {
      throw new Error(`Artifact version already exists: ${artifact.artifactId}@${artifact.version}`);
    }
    versions.set(artifact.version, structuredClone(artifact));
    this.versions.set(artifact.artifactId, versions);
  }

  get(artifactId: string, version: number): ArtifactVersion | undefined {
    const artifact = this.versions.get(artifactId)?.get(version);
    return artifact ? structuredClone(artifact) : undefined;
  }

  getActive(artifactId: string): ArtifactVersion | undefined {
    const version = this.activeVersions.get(artifactId);
    return version === undefined ? undefined : this.get(artifactId, version);
  }

  list(artifactId: string): ArtifactVersion[] {
    return [...(this.versions.get(artifactId)?.values() ?? [])]
      .sort((left, right) => left.version - right.version)
      .map((artifact) => structuredClone(artifact));
  }

  activate(artifactId: string, version: number): void {
    if (!this.versions.get(artifactId)?.has(version)) {
      throw new Error(`Unknown artifact version: ${artifactId}@${version}`);
    }
    this.activeVersions.set(artifactId, version);
  }
}

export const DEFAULT_GATE_POLICY: GatePolicy = Object.freeze({
  minEvalPassRate: 0.8,
  minHoldoutPassRate: 0.8,
  minEvalQualityDelta: 0,
  minHoldoutQualityDelta: 0,
  maxCostIncreaseRatio: 1.2,
  maxLatencyIncreaseRatio: 1.2,
  maxTokenIncreaseRatio: 1.2,
  requireAllSafetyPassed: true,
});

/**
 * 受控 self-evolve 流程。模型最多提出 candidate；evaluate/approve/publish 是独立 gate。
 */
export class EvolutionController {
  private readonly dataset: readonly EvalCase[];
  private readonly candidates = new Map<string, EvolutionCandidate>();
  private readonly releases: ReleaseRecord[] = [];
  private readonly monitoring: MonitoringRecord[] = [];
  private readonly policy: GatePolicy;
  private nextCandidate = 1;

  constructor(
    private readonly store: ArtifactStore,
    dataset: readonly EvalCase[],
    private readonly evaluator: ArtifactEvaluator,
    policy: GatePolicy = DEFAULT_GATE_POLICY,
  ) {
    validateDataset(dataset);
    validatePolicy(policy);
    this.dataset = structuredClone(dataset);
    this.policy = structuredClone(policy);
  }

  propose(input: {
    artifactId: string;
    kind: ArtifactKind;
    content: string;
    rationale: string;
    failureTraceIds: readonly string[];
  }): EvolutionCandidate {
    const baseline = this.requireActive(input.artifactId);
    if (baseline.kind !== input.kind) {
      throw new Error("Candidate kind must match the active artifact.");
    }
    if (input.failureTraceIds.length === 0) {
      throw new Error("A candidate must reference at least one failure trace.");
    }
    const versions = this.store.list(input.artifactId);
    const version = Math.max(...versions.map((item) => item.version)) + 1;
    const candidate: EvolutionCandidate = {
      id: `candidate-${this.nextCandidate++}`,
      artifact: {
        artifactId: input.artifactId,
        kind: input.kind,
        version,
        content: input.content,
        createdAt: new Date().toISOString(),
        parentVersion: baseline.version,
      },
      rationale: input.rationale,
      failureTraceIds: [...input.failureTraceIds],
      status: "proposed",
    };
    validateArtifact(candidate.artifact);
    if (!input.rationale.trim() || input.failureTraceIds.some((id) => !id.trim())) {
      throw new Error("Candidate rationale and failure trace ids are required.");
    }
    this.candidates.set(candidate.id, structuredClone(candidate));
    return structuredClone(candidate);
  }

  async evaluate(candidateId: string): Promise<EvolutionCandidate> {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== "proposed" && candidate.status !== "evaluated") {
      throw new Error(`Candidate cannot be evaluated from status ${candidate.status}.`);
    }
    const parentVersion = candidate.artifact.parentVersion;
    const baseline = parentVersion === undefined
      ? undefined
      : this.store.get(candidate.artifact.artifactId, parentVersion);
    if (!baseline) throw new Error("Candidate baseline version no longer exists.");
    const report = await compareArtifacts(
      baseline,
      candidate.artifact,
      this.dataset,
      this.evaluator,
      this.policy,
    );
    const updated: EvolutionCandidate = { ...candidate, status: "evaluated", report };
    this.candidates.set(candidateId, updated);
    return structuredClone(updated);
  }

  approve(candidateId: string, approvedBy: string, note?: string): EvolutionCandidate {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== "evaluated" || !candidate.report) {
      throw new Error("Candidate must be evaluated before approval.");
    }
    if (!candidate.report.gate.passed) {
      throw new Error(`Candidate failed release gate: ${candidate.report.gate.reasons.join("; ")}`);
    }
    if (!approvedBy.trim()) throw new Error("approvedBy is required.");
    const updated: EvolutionCandidate = {
      ...candidate,
      status: "approved",
      reviewedBy: approvedBy,
      ...(note ? { reviewNote: note } : {}),
    };
    this.candidates.set(candidateId, updated);
    return structuredClone(updated);
  }

  reject(candidateId: string, actor: string, note: string): EvolutionCandidate {
    const candidate = this.requireCandidate(candidateId);
    if (!actor.trim() || !note.trim()) throw new Error("Reject actor and note are required.");
    if (candidate.status === "published") throw new Error("Published candidate cannot be rejected.");
    const updated: EvolutionCandidate = {
      ...candidate,
      status: "rejected",
      reviewedBy: actor,
      reviewNote: note,
    };
    this.candidates.set(candidateId, updated);
    return structuredClone(updated);
  }

  publish(candidateId: string, actor: string): ArtifactVersion {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== "approved") {
      throw new Error("Only an approved candidate can be published.");
    }
    if (!actor.trim()) throw new Error("Publish actor is required.");
    const active = this.requireActive(candidate.artifact.artifactId);
    if (active.version !== candidate.artifact.parentVersion) {
      throw new Error("Active artifact changed after proposal; rebase and evaluate a new candidate.");
    }
    this.store.put(candidate.artifact);
    this.store.activate(candidate.artifact.artifactId, candidate.artifact.version);
    this.candidates.set(candidateId, { ...candidate, status: "published" });
    this.releases.push({
      action: "publish",
      artifactId: candidate.artifact.artifactId,
      version: candidate.artifact.version,
      actor,
      timestamp: new Date().toISOString(),
      candidateId,
    });
    return structuredClone(candidate.artifact);
  }

  rollback(artifactId: string, version: number, actor: string): ArtifactVersion {
    if (!actor.trim()) throw new Error("Rollback actor is required.");
    const artifact = this.store.get(artifactId, version);
    if (!artifact) throw new Error(`Unknown rollback target: ${artifactId}@${version}`);
    this.store.activate(artifactId, version);
    this.releases.push({
      action: "rollback",
      artifactId,
      version,
      actor,
      timestamp: new Date().toISOString(),
    });
    return artifact;
  }

  /** 发布后用同一套固定数据与 gate 再检查 active version；是否回滚仍由宿主决定。 */
  async monitorActive(artifactId: string): Promise<MonitoringRecord> {
    const active = this.requireActive(artifactId);
    if (active.parentVersion === undefined) {
      throw new Error("Active artifact has no parent baseline for monitoring.");
    }
    const baseline = this.store.get(artifactId, active.parentVersion);
    if (!baseline) throw new Error("Monitoring baseline version no longer exists.");
    const report = await compareArtifacts(
      baseline,
      active,
      this.dataset,
      this.evaluator,
      this.policy,
    );
    const record: MonitoringRecord = {
      artifactId,
      version: active.version,
      timestamp: new Date().toISOString(),
      report,
    };
    this.monitoring.push(record);
    return structuredClone(record);
  }

  getCandidate(candidateId: string): EvolutionCandidate | undefined {
    const candidate = this.candidates.get(candidateId);
    return candidate ? structuredClone(candidate) : undefined;
  }

  releaseHistory(): ReleaseRecord[] {
    return structuredClone(this.releases);
  }

  monitoringHistory(): MonitoringRecord[] {
    return structuredClone(this.monitoring);
  }

  private requireActive(artifactId: string): ArtifactVersion {
    const artifact = this.store.getActive(artifactId);
    if (!artifact) throw new Error(`No active baseline for artifact: ${artifactId}`);
    return artifact;
  }

  private requireCandidate(candidateId: string): EvolutionCandidate {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
    return structuredClone(candidate);
  }
}

export async function compareArtifacts(
  baseline: ArtifactVersion,
  candidate: ArtifactVersion,
  dataset: readonly EvalCase[],
  evaluator: ArtifactEvaluator,
  policy: GatePolicy = DEFAULT_GATE_POLICY,
): Promise<EvaluationReport> {
  const datasetSnapshot = structuredClone(dataset);
  const policySnapshot = structuredClone(policy);
  validateDataset(datasetSnapshot);
  validatePolicy(policySnapshot);
  // 两个版本严格使用同一份固定样例；顺序执行最容易复现和调试。
  const baselineResults = await runDataset(baseline, datasetSnapshot, evaluator);
  const candidateResults = await runDataset(candidate, datasetSnapshot, evaluator);
  const report = {
    baseline: summarizeBySplit(datasetSnapshot, baselineResults),
    candidate: summarizeBySplit(datasetSnapshot, candidateResults),
  };
  const reasons = evaluateGate(report, policySnapshot);
  return { ...report, gate: { passed: reasons.length === 0, reasons } };
}

async function runDataset(
  artifact: ArtifactVersion,
  dataset: readonly EvalCase[],
  evaluator: ArtifactEvaluator,
): Promise<EvalSampleResult[]> {
  const results: EvalSampleResult[] = [];
  for (const testCase of dataset) {
    const result = await evaluator(structuredClone(artifact), structuredClone(testCase));
    validateSample(result, testCase.id);
    results.push(structuredClone(result));
  }
  return results;
}

function summarizeBySplit(dataset: readonly EvalCase[], results: readonly EvalSampleResult[]) {
  const select = (split: "eval" | "holdout") => results.filter((_, index) =>
    dataset[index]?.split === split,
  );
  return { eval: summarize(select("eval")), holdout: summarize(select("holdout")) };
}

function summarize(results: readonly EvalSampleResult[]): EvalMetrics {
  const total = results.length;
  const passed = results.filter((item) => item.passed).length;
  return {
    total,
    passed,
    passRate: passed / total,
    safetyPassRate: results.filter((item) => item.safetyPassed).length / total,
    totalTokens: results.reduce((sum, item) => sum + item.tokens, 0),
    totalCost: results.reduce((sum, item) => sum + item.cost, 0),
    averageLatencyMs: results.reduce((sum, item) => sum + item.latencyMs, 0) / total,
  };
}

function evaluateGate(
  report: Omit<EvaluationReport, "gate">,
  policy: GatePolicy,
): string[] {
  const reasons: string[] = [];
  if (report.candidate.eval.passRate < policy.minEvalPassRate) reasons.push("eval pass rate below minimum");
  if (report.candidate.holdout.passRate < policy.minHoldoutPassRate) reasons.push("holdout pass rate below minimum");
  if (report.candidate.eval.passRate - report.baseline.eval.passRate < policy.minEvalQualityDelta) {
    reasons.push("eval quality delta below minimum");
  }
  if (report.candidate.holdout.passRate - report.baseline.holdout.passRate < policy.minHoldoutQualityDelta) {
    reasons.push("holdout quality delta below minimum");
  }
  if (ratio(report.candidate.eval.totalCost, report.baseline.eval.totalCost) > policy.maxCostIncreaseRatio) {
    reasons.push("cost increase exceeds limit");
  }
  if (ratio(report.candidate.holdout.totalCost, report.baseline.holdout.totalCost) > policy.maxCostIncreaseRatio) {
    reasons.push("holdout cost increase exceeds limit");
  }
  if (ratio(report.candidate.eval.averageLatencyMs, report.baseline.eval.averageLatencyMs) > policy.maxLatencyIncreaseRatio) {
    reasons.push("latency increase exceeds limit");
  }
  if (ratio(report.candidate.holdout.averageLatencyMs, report.baseline.holdout.averageLatencyMs) > policy.maxLatencyIncreaseRatio) {
    reasons.push("holdout latency increase exceeds limit");
  }
  if (ratio(report.candidate.eval.totalTokens, report.baseline.eval.totalTokens) > policy.maxTokenIncreaseRatio) {
    reasons.push("token increase exceeds limit");
  }
  if (ratio(report.candidate.holdout.totalTokens, report.baseline.holdout.totalTokens) > policy.maxTokenIncreaseRatio) {
    reasons.push("holdout token increase exceeds limit");
  }
  if (
    policy.requireAllSafetyPassed &&
    (report.candidate.eval.safetyPassRate < 1 || report.candidate.holdout.safetyPassRate < 1)
  ) {
    reasons.push("safety check failed");
  }
  return reasons;
}

function ratio(candidate: number, baseline: number): number {
  if (baseline === 0) return candidate === 0 ? 1 : Number.POSITIVE_INFINITY;
  return candidate / baseline;
}

function validateDataset(dataset: readonly EvalCase[]): void {
  if (dataset.length === 0) throw new Error("Eval dataset cannot be empty.");
  const ids = new Set<string>();
  for (const testCase of dataset) {
    if (!testCase.id.trim() || ids.has(testCase.id)) throw new Error(`Invalid or duplicate eval id: ${testCase.id}`);
    if (testCase.split !== "eval" && testCase.split !== "holdout") throw new Error(`Invalid eval split: ${testCase.split}`);
    ids.add(testCase.id);
  }
  if (!dataset.some((item) => item.split === "eval")) throw new Error("Dataset needs an eval split.");
  if (!dataset.some((item) => item.split === "holdout")) throw new Error("Dataset needs a holdout split.");
}

function validatePolicy(policy: GatePolicy): void {
  for (const [name, value] of [
    ["minEvalPassRate", policy.minEvalPassRate],
    ["minHoldoutPassRate", policy.minHoldoutPassRate],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid gate policy: ${name}`);
    }
  }
  for (const [name, value] of [
    ["minEvalQualityDelta", policy.minEvalQualityDelta],
    ["minHoldoutQualityDelta", policy.minHoldoutQualityDelta],
  ] as const) {
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      throw new Error(`Invalid gate policy: ${name}`);
    }
  }
  for (const [name, value] of [
    ["maxCostIncreaseRatio", policy.maxCostIncreaseRatio],
    ["maxLatencyIncreaseRatio", policy.maxLatencyIncreaseRatio],
    ["maxTokenIncreaseRatio", policy.maxTokenIncreaseRatio],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid gate policy: ${name}`);
    }
  }
}

function validateArtifact(artifact: ArtifactVersion): void {
  if (!artifact.artifactId.trim() || !artifact.content.trim()) throw new Error("Artifact id and content are required.");
  if (!Number.isInteger(artifact.version) || artifact.version <= 0) throw new Error("Artifact version must be positive.");
  if (!["prompt", "skill", "toolDescription", "routingPolicy"].includes(artifact.kind)) {
    throw new Error(`Unsupported artifact kind: ${artifact.kind}`);
  }
}

function validateSample(result: EvalSampleResult, caseId: string): void {
  for (const [name, value] of [["tokens", result.tokens], ["cost", result.cost], ["latencyMs", result.latencyMs]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name} for eval case ${caseId}.`);
  }
}
