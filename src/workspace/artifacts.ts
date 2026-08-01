export type FileArtifact = {
  id: string;
  name: string;
  mediaType: string;
  content: string;
  createdAt: string;
};

export interface FileArtifactStore {
  put(artifact: Omit<FileArtifact, "id" | "createdAt">): FileArtifact;
  get(id: string): FileArtifact | undefined;
  list(): FileArtifact[];
}

/** 长输出保存在宿主，而不是全部塞回模型 Context。 */
export class InMemoryFileArtifactStore implements FileArtifactStore {
  private readonly artifacts = new Map<string, FileArtifact>();
  private nextId = 1;

  put(input: Omit<FileArtifact, "id" | "createdAt">): FileArtifact {
    const artifact: FileArtifact = {
      ...input,
      id: `artifact-${this.nextId++}`,
      createdAt: new Date().toISOString(),
    };
    this.artifacts.set(artifact.id, structuredClone(artifact));
    return structuredClone(artifact);
  }

  get(id: string): FileArtifact | undefined {
    const artifact = this.artifacts.get(id);
    return artifact ? structuredClone(artifact) : undefined;
  }

  list(): FileArtifact[] {
    return [...this.artifacts.values()].map((item) => structuredClone(item));
  }
}
