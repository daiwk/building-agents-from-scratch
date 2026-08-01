import {
  runSubagent,
  type HandoffResult,
  type RunSubagentOptions,
} from "./agent-as-tool.js";

export type ScheduledSubagent = Omit<RunSubagentOptions, "signal">;

/** 有界并发 scheduler；结果顺序与输入任务一致，便于 reducer 确定性合并。 */
export class SubagentScheduler {
  constructor(private readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error("Scheduler concurrency must be a positive integer.");
    }
  }

  async run(
    tasks: readonly ScheduledSubagent[],
    signal?: AbortSignal,
  ): Promise<HandoffResult[]> {
    return this.runWorkers(
      tasks.map((task) => () => runSubagent({
        ...task,
        ...(signal ? { signal } : {}),
      })),
    );
  }

  /**
   * 运行任意返回 HandoffResult 的 worker。
   * 这个小接口让 pi-agent 等成熟实现也能复用相同的限并发调度器。
   */
  async runWorkers(
    workers: readonly (() => Promise<HandoffResult>)[],
  ): Promise<HandoffResult[]> {
    const results = new Array<HandoffResult>(workers.length);
    let next = 0;
    const worker = async () => {
      while (next < workers.length) {
        const index = next++;
        const run = workers[index];
        if (run) results[index] = await run();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, workers.length) }, worker),
    );
    return results;
  }
}
