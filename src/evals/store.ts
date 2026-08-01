import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ReplayEvalCase, StoredEvaluationReport } from "./types.js";
import { validateReplayDataset } from "./replay.js";

export class JsonlEvalDatasetStore {
  constructor(readonly filePath: string) {}

  load(): ReplayEvalCase[] {
    const text = readFileSync(this.filePath, "utf8");
    const dataset = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as ReplayEvalCase; }
      catch { throw new Error(`Invalid JSONL at line ${index + 1}.`); }
    });
    validateReplayDataset(dataset);
    return dataset;
  }

  save(dataset: readonly ReplayEvalCase[]): void {
    validateReplayDataset(dataset);
    atomicWrite(this.filePath, dataset.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }
}

export class JsonEvalReportStore {
  constructor(readonly directory: string) {}

  save(report: StoredEvaluationReport): string {
    const file = resolve(this.directory, `eval-${Date.now()}-${randomUUID()}.json`);
    atomicWrite(file, JSON.stringify(report, null, 2) + "\n");
    return file;
  }

  load(filePath: string): StoredEvaluationReport {
    return JSON.parse(readFileSync(filePath, "utf8")) as StoredEvaluationReport;
  }
}

function atomicWrite(filePath: string, content: string): void {
  const target = resolve(filePath);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}
