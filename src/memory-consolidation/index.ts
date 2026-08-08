/**
 * Evidence-first memory consolidation inspired by arXiv:2605.12978.
 *
 * 关键区别：episode 是不可变证据；抽象 memory 只是可以评测、拒绝和回滚的候选版本，
 * 永远不能覆盖产生它的原始轨迹。
 */

export type Episode = {
  id: string;
  scope: string;
  taskId: string;
  tags: string[];
  input: string;
  trajectory: string;
  outcome: "success" | "failure";
  createdAt: string;
};

export type Applicability = {
  /** 当前任务必须包含全部标签。 */
  allTags: string[];
  /** 出现任意标签时，这条抽象不得注入。 */
  noneTags: string[];
};

export type EvidenceLink = {
  episodeId: string;
  relation: "support" | "counterexample";
};

export type ConsolidationCandidate = {
  id: string;
  memoryId: string;
  version: number;
  parentVersion?: number;
  scope: string;
  lesson: string;
  applicability: Applicability;
  evidence: EvidenceLink[];
  rationale: string;
  status: "proposed" | "evaluated" | "active" | "rejected" | "superseded";
  createdAt: string;
  report?: ConsolidationReport;
  reviewedBy?: string;
};

export type ConsolidationReplayCase = {
  id: string;
  tags: string[];
  shouldApply: boolean;
  baselinePassed: boolean;
};

export type ConsolidationReport = {
  passed: boolean;
  reasons: string[];
  supportingEpisodes: number;
  distinctSupportingTasks: number;
  counterexamples: number;
  replay: Array<{
    caseId: string;
    applied: boolean;
    shouldApply: boolean;
    baselinePassed: boolean;
    candidatePassed: boolean;
  }>;
};

export type ConsolidationPolicy = {
  minSupportingEpisodes?: number;
  minDistinctSupportingTasks?: number;
  requireCounterexample?: boolean;
  requireReplayImprovement?: boolean;
};

export type ConsolidationEvaluator = (
  candidate: Readonly<ConsolidationCandidate>,
  testCase: Readonly<ConsolidationReplayCase>,
) => boolean | Promise<boolean>;

export type ActiveMemory = {
  memoryId: string;
  version: number;
  lesson: string;
  scope: string;
  sourceEpisodeIds: string[];
};

export type ConsolidationRelease = {
  action: "activate" | "rollback";
  memoryId: string;
  version: number;
  actor: string;
  timestamp: string;
};

export class GovernedMemoryBank {
  private readonly episodes = new Map<string, Episode>();
  private readonly candidates = new Map<string, ConsolidationCandidate>();
  private readonly activeVersions = new Map<string, number>();
  private readonly releases: ConsolidationRelease[] = [];
  private nextCandidateId = 1;

  /** 同一 id 只允许写入一次；consolidation 没有删除或覆盖 episode 的入口。 */
  retain(episode: Episode): void {
    validateEpisode(episode);
    const existing = this.episodes.get(episode.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(episode)) {
      throw new Error(`Episode is immutable: ${episode.id}.`);
    }
    if (!existing) this.episodes.set(episode.id, structuredClone(episode));
  }

  propose(input: Omit<ConsolidationCandidate,
    "id" | "version" | "parentVersion" | "status" | "createdAt" | "report" | "reviewedBy"
  >): ConsolidationCandidate {
    validateCandidateInput(input);
    const versions = [...this.candidates.values()]
      .filter((candidate) => candidate.memoryId === input.memoryId)
      .map((candidate) => candidate.version);
    const parentVersion = this.activeVersions.get(input.memoryId);
    const candidate: ConsolidationCandidate = {
      ...structuredClone(input),
      id: `memory-candidate-${this.nextCandidateId++}`,
      version: Math.max(0, ...versions) + 1,
      ...(parentVersion === undefined ? {} : { parentVersion }),
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    this.requireEvidenceExists(candidate);
    this.candidates.set(candidate.id, candidate);
    return structuredClone(candidate);
  }

  async evaluate(
    candidateId: string,
    cases: readonly ConsolidationReplayCase[],
    evaluator: ConsolidationEvaluator,
    policy: ConsolidationPolicy = {},
  ): Promise<ConsolidationCandidate> {
    const candidate = this.requireCandidate(candidateId);
    if (!new Set(["proposed", "evaluated"]).has(candidate.status)) {
      throw new Error(`Candidate cannot be evaluated from ${candidate.status}.`);
    }
    validateReplayCases(cases);
    const supporting = candidate.evidence.filter((item) => item.relation === "support");
    const counterexamples = candidate.evidence.filter((item) => item.relation === "counterexample");
    const supportingEpisodes = supporting.map((item) => this.episodes.get(item.episodeId)!);
    const counterexampleEpisodes = counterexamples.map((item) => this.episodes.get(item.episodeId)!);
    const distinctTasks = new Set(supportingEpisodes.map((episode) => episode.taskId)).size;
    const reasons: string[] = [];
    if (supporting.length < (policy.minSupportingEpisodes ?? 2)) {
      reasons.push("not enough supporting episodes");
    }
    if (distinctTasks < (policy.minDistinctSupportingTasks ?? 2)) {
      reasons.push("supporting evidence is too narrow");
    }
    if ((policy.requireCounterexample ?? true) && counterexamples.length === 0) {
      reasons.push("no counterexample defines the applicability boundary");
    }
    if ((policy.requireCounterexample ?? true) && !cases.some((testCase) => !testCase.shouldApply)) {
      reasons.push("replay set does not test an applicability boundary");
    }
    if (supportingEpisodes.some((episode) => episode.scope !== candidate.scope)) {
      reasons.push("supporting episodes mix different scopes");
    }
    if (supportingEpisodes.some((episode) => !appliesTo(candidate.applicability, episode.tags))) {
      reasons.push("applicability excludes supporting evidence");
    }
    if (counterexampleEpisodes.some((episode) => appliesTo(candidate.applicability, episode.tags))) {
      reasons.push("applicability still includes a counterexample");
    }

    const replay = [];
    let improvements = 0;
    for (const testCase of cases) {
      const applied = appliesTo(candidate.applicability, testCase.tags);
      const candidatePassed = await evaluator(candidate, testCase);
      if (applied !== testCase.shouldApply) reasons.push(`applicability mismatch: ${testCase.id}`);
      if (testCase.baselinePassed && !candidatePassed) reasons.push(`replay regression: ${testCase.id}`);
      if (!testCase.baselinePassed && candidatePassed) improvements += 1;
      replay.push({
        caseId: testCase.id, applied, shouldApply: testCase.shouldApply,
        baselinePassed: testCase.baselinePassed, candidatePassed,
      });
    }
    if ((policy.requireReplayImprovement ?? true) && improvements === 0) {
      reasons.push("candidate does not improve any replay case");
    }
    const report: ConsolidationReport = {
      passed: reasons.length === 0,
      reasons: [...new Set(reasons)],
      supportingEpisodes: supporting.length,
      distinctSupportingTasks: distinctTasks,
      counterexamples: counterexamples.length,
      replay,
    };
    const updated = { ...candidate, status: "evaluated" as const, report };
    this.candidates.set(candidateId, updated);
    return structuredClone(updated);
  }

  reject(candidateId: string, actor: string): ConsolidationCandidate {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status === "active") throw new Error("Active memory must be rolled back, not rejected.");
    if (!actor.trim()) throw new Error("Reviewer identity is required.");
    const updated = { ...candidate, status: "rejected" as const, reviewedBy: actor };
    this.candidates.set(candidateId, updated);
    return structuredClone(updated);
  }

  activate(candidateId: string, actor: string): ConsolidationCandidate {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== "evaluated" || !candidate.report?.passed) {
      throw new Error("Only a candidate that passed the consolidation gate can be activated.");
    }
    if (!actor.trim()) throw new Error("Activator identity is required.");
    if (this.activeVersions.get(candidate.memoryId) !== candidate.parentVersion) {
      throw new Error("Active memory changed; propose and evaluate a new candidate.");
    }
    for (const [id, item] of this.candidates) {
      if (item.memoryId === candidate.memoryId && item.status === "active") {
        this.candidates.set(id, { ...item, status: "superseded" });
      }
    }
    const updated = { ...candidate, status: "active" as const, reviewedBy: actor };
    this.candidates.set(candidateId, updated);
    this.activeVersions.set(candidate.memoryId, candidate.version);
    this.releases.push({
      action: "activate", memoryId: candidate.memoryId, version: candidate.version,
      actor, timestamp: new Date().toISOString(),
    });
    return structuredClone(updated);
  }

  rollback(memoryId: string, version: number, actor: string): ConsolidationCandidate {
    if (!actor.trim()) throw new Error("Rollback actor is required.");
    const target = [...this.candidates.values()].find((candidate) =>
      candidate.memoryId === memoryId && candidate.version === version && candidate.report?.passed
    );
    if (!target) throw new Error(`Unknown gated memory version: ${memoryId}@${version}.`);
    if (!this.releases.some((release) => release.memoryId === memoryId && release.version === version)) {
      throw new Error("Rollback target was never active.");
    }
    for (const [id, item] of this.candidates) {
      if (item.memoryId === memoryId && item.status === "active") {
        this.candidates.set(id, { ...item, status: "superseded" });
      }
    }
    const active = { ...target, status: "active" as const, reviewedBy: actor };
    this.candidates.set(target.id, active);
    this.activeVersions.set(memoryId, version);
    this.releases.push({
      action: "rollback", memoryId, version, actor, timestamp: new Date().toISOString(),
    });
    return structuredClone(active);
  }

  active(tags: readonly string[]): ActiveMemory[] {
    return [...this.activeVersions.entries()].flatMap(([memoryId, version]) => {
      const candidate = [...this.candidates.values()].find((item) =>
        item.memoryId === memoryId && item.version === version
      );
      if (!candidate || !appliesTo(candidate.applicability, tags)) return [];
      return [{
        memoryId, version, lesson: candidate.lesson, scope: candidate.scope,
        sourceEpisodeIds: candidate.evidence.map((item) => item.episodeId),
      }];
    });
  }

  getEpisode(id: string): Episode | undefined {
    const episode = this.episodes.get(id);
    return episode ? structuredClone(episode) : undefined;
  }

  getCandidate(id: string): ConsolidationCandidate | undefined {
    const candidate = this.candidates.get(id);
    return candidate ? structuredClone(candidate) : undefined;
  }

  releaseHistory(): ConsolidationRelease[] {
    return structuredClone(this.releases);
  }

  private requireCandidate(id: string): ConsolidationCandidate {
    const candidate = this.candidates.get(id);
    if (!candidate) throw new Error(`Unknown consolidation candidate: ${id}.`);
    return candidate;
  }

  private requireEvidenceExists(candidate: ConsolidationCandidate): void {
    for (const link of candidate.evidence) {
      if (!this.episodes.has(link.episodeId)) throw new Error(`Unknown evidence episode: ${link.episodeId}.`);
    }
  }
}

export function appliesTo(applicability: Applicability, tags: readonly string[]): boolean {
  const available = new Set(tags);
  return applicability.allTags.every((tag) => available.has(tag)) &&
    applicability.noneTags.every((tag) => !available.has(tag));
}

/** 只渲染已经通过 gate 且适用于当前任务的 abstraction，并保留 episode 引用。 */
export function applyGovernedMemoriesToPrompt(
  basePrompt: string,
  memories: readonly ActiveMemory[],
): string {
  if (!memories.length) return basePrompt;
  const section = memories.map((memory) =>
    `<governed_memory id="${escape(memory.memoryId)}" version="${memory.version}" ` +
    `scope="${escape(memory.scope)}" sources="${memory.sourceEpisodeIds.map(escape).join(",")}">` +
    `${escape(memory.lesson)}</governed_memory>`
  ).join("\n");
  return `${basePrompt}\n\n# Gated memories\n\n${section}`;
}

function validateEpisode(episode: Episode): void {
  for (const [name, value] of [["id", episode.id], ["scope", episode.scope], ["taskId", episode.taskId]] as const) {
    if (!/^[\w.-]{1,120}$/.test(value)) throw new Error(`Invalid episode ${name}.`);
  }
  if (!episode.tags.length || !episode.input.trim() || !episode.trajectory.trim()) {
    throw new Error("Episode tags, input and trajectory are required.");
  }
  if (episode.tags.some((tag) => !tag.trim())) throw new Error("Episode tags cannot be empty.");
  if (!new Set(["success", "failure"]).has(episode.outcome)) throw new Error("Invalid episode outcome.");
  if (!Number.isFinite(Date.parse(episode.createdAt))) throw new Error("Invalid episode createdAt.");
}

function validateCandidateInput(input: Omit<ConsolidationCandidate,
  "id" | "version" | "parentVersion" | "status" | "createdAt" | "report" | "reviewedBy"
>): void {
  if (!/^[\w.-]{1,120}$/.test(input.memoryId) || !/^[\w.-]{1,120}$/.test(input.scope)) {
    throw new Error("Invalid memory id or scope.");
  }
  if (!input.lesson.trim() || !input.rationale.trim() || !input.evidence.length) {
    throw new Error("Lesson, rationale and evidence are required.");
  }
  if (!input.applicability.allTags.length) throw new Error("At least one applicability tag is required.");
  const all = new Set(input.applicability.allTags);
  if (input.applicability.noneTags.some((tag) => all.has(tag))) {
    throw new Error("Applicability tags cannot be both required and excluded.");
  }
  if (new Set(input.evidence.map((item) => item.episodeId)).size !== input.evidence.length) {
    throw new Error("Evidence episode ids must be unique.");
  }
  if (input.evidence.some((item) => !new Set(["support", "counterexample"]).has(item.relation))) {
    throw new Error("Invalid evidence relation.");
  }
}

function validateReplayCases(cases: readonly ConsolidationReplayCase[]): void {
  if (!cases.length || new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("Replay cases must be non-empty and have unique ids.");
  }
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
