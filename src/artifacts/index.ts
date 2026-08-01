import { createHash, randomUUID } from "node:crypto";

export const ALLOWED_ARTIFACT_TYPES = new Set([
  "text/plain", "text/markdown", "application/json",
  "image/png", "image/jpeg", "image/webp",
]);

export type Artifact = {
  id: string; name: string; mimeType: string; size: number;
  sha256: string; data: Buffer; createdAt: string;
};

/** 教学用内存制品仓库：限制类型和大小，不根据文件名猜 MIME，也不执行上传内容。 */
export class InMemoryArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();

  constructor(private readonly maxBytes = 2 * 1024 * 1024) {}

  create(name: string, mimeType: string, data: Buffer): Artifact {
    if (!ALLOWED_ARTIFACT_TYPES.has(mimeType)) throw new Error("Unsupported artifact type.");
    if (!data.length || data.length > this.maxBytes) throw new Error("Artifact size is invalid.");
    const artifact = {
      id: randomUUID(), name: name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file",
      mimeType, size: data.length, sha256: createHash("sha256").update(data).digest("hex"),
      data: Buffer.from(data), createdAt: new Date().toISOString(),
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  get(id: string): Artifact | undefined { return this.artifacts.get(id); }
  metadata(artifact: Artifact) {
    const { data: _data, ...metadata } = artifact;
    return metadata;
  }
}
