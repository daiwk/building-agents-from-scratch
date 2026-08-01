/** Stage 6 中允许演进的配置；故意不包含可执行代码。 */
export type ArtifactKind =
  | "prompt"
  | "skill"
  | "toolDescription"
  | "routingPolicy";

/** 一个版本一旦写入 store 就不再修改，只能发布更新版本或回滚。 */
export type ArtifactVersion = {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly version: number;
  readonly content: string;
  readonly createdAt: string;
  readonly parentVersion?: number;
};

export type EvalSplit = "eval" | "holdout";

/** pass/fail 由业务 rubric 决定；holdout 用来发现只针对公开样例的过拟合。 */
export type EvalCase = {
  readonly id: string;
  readonly input: string;
  readonly split: EvalSplit;
  readonly expected?: string;
};

export type EvalSampleResult = {
  readonly output: string;
  readonly passed: boolean;
  readonly safetyPassed: boolean;
  readonly tokens: number;
  readonly cost: number;
  readonly latencyMs: number;
};

export type ArtifactEvaluator = (
  artifact: Readonly<ArtifactVersion>,
  testCase: Readonly<EvalCase>,
) => Promise<EvalSampleResult>;

export type EvalMetrics = {
  readonly total: number;
  readonly passed: number;
  readonly passRate: number;
  readonly safetyPassRate: number;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly averageLatencyMs: number;
};

export type GatePolicy = {
  readonly minEvalPassRate: number;
  readonly minHoldoutPassRate: number;
  readonly minEvalQualityDelta: number;
  readonly minHoldoutQualityDelta: number;
  readonly maxCostIncreaseRatio: number;
  readonly maxLatencyIncreaseRatio: number;
  readonly maxTokenIncreaseRatio: number;
  readonly requireAllSafetyPassed: boolean;
};

export type EvaluationReport = {
  readonly baseline: {
    readonly eval: EvalMetrics;
    readonly holdout: EvalMetrics;
  };
  readonly candidate: {
    readonly eval: EvalMetrics;
    readonly holdout: EvalMetrics;
  };
  readonly gate: {
    readonly passed: boolean;
    readonly reasons: readonly string[];
  };
};

export type CandidateStatus =
  | "proposed"
  | "evaluated"
  | "approved"
  | "rejected"
  | "published";

export type EvolutionCandidate = {
  readonly id: string;
  readonly artifact: ArtifactVersion;
  readonly rationale: string;
  readonly failureTraceIds: readonly string[];
  readonly status: CandidateStatus;
  readonly report?: EvaluationReport;
  readonly reviewedBy?: string;
  readonly reviewNote?: string;
};

export type ReleaseRecord = {
  readonly action: "publish" | "rollback";
  readonly artifactId: string;
  readonly version: number;
  readonly actor: string;
  readonly timestamp: string;
  readonly candidateId?: string;
};

export type MonitoringRecord = {
  readonly artifactId: string;
  readonly version: number;
  readonly timestamp: string;
  readonly report: EvaluationReport;
};

export interface ArtifactStore {
  put(artifact: ArtifactVersion): void;
  get(artifactId: string, version: number): ArtifactVersion | undefined;
  getActive(artifactId: string): ArtifactVersion | undefined;
  list(artifactId: string): ArtifactVersion[];
  activate(artifactId: string, version: number): void;
}
