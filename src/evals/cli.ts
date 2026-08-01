import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareArtifacts, type ArtifactVersion } from "../evolution/index.js";
import {
  JsonEvalReportStore,
  JsonlEvalDatasetStore,
  TraceReplayEvaluator,
  datasetFingerprint,
  toEvalCases,
} from "./index.js";

const args = parseArgs(process.argv.slice(2));
if (args.command !== "run") usage();
const datasetPath = required(args, "dataset");
const baseline = readArtifact(required(args, "baseline"));
const candidate = readArtifact(required(args, "candidate"));
const dataset = new JsonlEvalDatasetStore(datasetPath).load();
const replay = new TraceReplayEvaluator(dataset);
const report = await compareArtifacts(
  baseline,
  candidate,
  toEvalCases(dataset),
  replay.asEvaluator(),
);
const stored = {
  datasetFingerprint: datasetFingerprint(dataset),
  baselineVersion: baseline.version,
  candidateVersion: candidate.version,
  createdAt: new Date().toISOString(),
  report,
};
const reportFile = new JsonEvalReportStore(args.report ?? ".agent-data/evals").save(stored);
console.log(JSON.stringify({ reportFile, ...stored }, null, 2));
if (!report.gate.passed) process.exitCode = 2;

function readArtifact(path: string): ArtifactVersion {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as ArtifactVersion;
}

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (values[0]) result.command = values[0];
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    result[key.slice(2)] = value;
  }
  return result;
}

function required(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) usage();
  return value;
}

function usage(): never {
  throw new Error("Usage: npm run eval -- run --dataset FILE --baseline FILE --candidate FILE [--report DIR]");
}
