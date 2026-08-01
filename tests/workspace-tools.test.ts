import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceToolKit } from "../src/workspace/index.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("safe workspace tools", () => {
  it("lists, reads, searches, writes atomically, and stores long output as an artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-workspace-"));
    directories.push(root);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "notes.txt"), "alpha\nbeta\n" + "x".repeat(100));
    const kit = createWorkspaceToolKit({ root, allowWrite: true, maxInlineCharacters: 30 });
    const tools = Object.fromEntries(kit.registry.list().map((tool) => [tool.name, tool]));

    expect(await tools.list_files?.execute({ path: "." }, { messages: [] })).toContain("docs/notes.txt");
    expect(await tools.search_text?.execute({ query: "beta" }, { messages: [] })).toContain("notes.txt:2:beta");
    const read = await tools.read_file?.execute({ path: "docs/notes.txt" }, { messages: [] });
    expect(read).toContain("artifact=artifact-1");
    expect(kit.artifacts.get("artifact-1")?.content).toContain("alpha");
    expect(await tools.read_artifact?.execute({ id: "artifact-1", offset: 0, limit: 5 }, { messages: [] })).toContain("alpha");
    await tools.write_file?.execute({ path: "docs/result.txt", content: "done" }, { messages: [] });
    expect(await readFile(join(root, "docs", "result.txt"), "utf8")).toBe("done");
  });

  it("is read-only by default and blocks traversal and symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-outside-"));
    directories.push(root, outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    const kit = createWorkspaceToolKit({ root });
    expect(kit.registry.list().map((tool) => tool.name)).not.toContain("write_file");
    const read = kit.registry.select(["read_file"])[0]!;
    expect(() => read.execute({ path: "../secret.txt" }, { messages: [] })).toThrow("escapes");
    expect(() => read.execute({ path: "escape/secret.txt" }, { messages: [] })).toThrow("escapes");
  });
});
