import type { EvalSampleResult, EvalSplit, EvaluationReport } from "../evolution/index.js";

export type ReplayEvent =
  | { type: "agentStart" }
  | { type: "turnStart"; turn: number }
  | { type: "toolStart"; callId: string; name: string }
  | { type: "toolEnd"; callId: string; result: string; isError: boolean }
  | { type: "text"; text: string }
  | { type: "usage"; tokens: number; cost: number }
  | { type: "agentEnd" };

export type RecordedRun = {
  artifactVersion: number;
  output: string;
  safetyPassed: boolean;
  tokens: number;
  cost: number;
  latencyMs: number;
  events: ReplayEvent[];
};

export type ReplayEvalCase = {
  id: string;
  input: string;
  split: EvalSplit;
  expected: string;
  rubric: "equals" | "contains";
  runs: Record<string, RecordedRun>;
};

export type RecordedTrace = RecordedRun & {
  input: string;
};

export type ReplayResult = {
  caseId: string;
  artifactVersion: number;
  events: ReplayEvent[];
  result: EvalSampleResult;
};

export type StoredEvaluationReport = {
  datasetFingerprint: string;
  baselineVersion: number;
  candidateVersion: number;
  createdAt: string;
  report: EvaluationReport;
};
