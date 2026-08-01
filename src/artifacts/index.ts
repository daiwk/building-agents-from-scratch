import { createHash, randomUUID } from "node:crypto";

export const ALLOWED_ARTIFACT_TYPES = new Set([
  "text/plain", "text/markdown", "application/json",
  "image/png", "image/jpeg", "image/webp",
]);

export type Artifact = {
  id: string; tenantId: string; name: string; mimeType: string; size: number;
  sha256: string; data: Buffer; createdAt: string;
};

/** 教学用内存制品仓库：限制类型和大小，不根据文件名猜 MIME，也不执行上传内容。 */
export class InMemoryArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();

  constructor(private readonly maxBytes = 2 * 1024 * 1024) {}

  create(tenantId: string, name: string, mimeType: string, data: Buffer): Artifact {
    if (!/^[\w.-]{1,120}$/.test(tenantId)) throw new Error("Invalid tenant id.");
    if (!ALLOWED_ARTIFACT_TYPES.has(mimeType)) throw new Error("Unsupported artifact type.");
    if (!data.length || data.length > this.maxBytes) throw new Error("Artifact size is invalid.");
    const artifact = {
      id: randomUUID(), tenantId, name: name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file",
      mimeType, size: data.length, sha256: createHash("sha256").update(data).digest("hex"),
      data: Buffer.from(data), createdAt: new Date().toISOString(),
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  get(tenantId: string, id: string): Artifact | undefined {
    const artifact = this.artifacts.get(id);
    return artifact?.tenantId === tenantId ? artifact : undefined;
  }
  metadata(artifact: Artifact) {
    const { data: _data, tenantId: _tenantId, ...metadata } = artifact;
    return metadata;
  }
}
