export type GraphState = Record<string, unknown>;

export type GraphFork = {
  fork: string[];
  join: string;
};

export type GraphNodeContext = {
  signal?: AbortSignal;
  resumeValue?: unknown;
  interrupt(value: unknown): never;
};

export type GraphNode<TState extends GraphState> = (
  state: Readonly<TState>,
  context: GraphNodeContext,
) => Promise<Partial<TState> | GraphFork | void> | Partial<TState> | GraphFork | void;

export type GraphCheckpoint<TState extends GraphState> = {
  state: TState;
  nextNode: string;
  steps: number;
  interruptValue?: unknown;
};

export type GraphCheckpointStore<TState extends GraphState> = {
  load(id: string): Promise<GraphCheckpoint<TState> | undefined>;
  save(id: string, checkpoint: GraphCheckpoint<TState>): Promise<void>;
  clear(id: string): Promise<void>;
};

export class InMemoryGraphCheckpointStore<TState extends GraphState>
implements GraphCheckpointStore<TState> {
  private readonly checkpoints = new Map<string, GraphCheckpoint<TState>>();

  async load(id: string): Promise<GraphCheckpoint<TState> | undefined> {
    const value = this.checkpoints.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async save(id: string, checkpoint: GraphCheckpoint<TState>): Promise<void> {
    this.checkpoints.set(id, structuredClone(checkpoint));
  }

  async clear(id: string): Promise<void> {
    this.checkpoints.delete(id);
  }
}

export type GraphRunResult<TState extends GraphState> =
  | { status: "completed"; state: TState; steps: number }
  | { status: "interrupted"; state: TState; steps: number; value: unknown };

type Edge<TState extends GraphState> = {
  to: string;
  when?: (state: Readonly<TState>) => boolean;
};

class GraphInterrupt extends Error {
  constructor(readonly value: unknown) {
    super("Graph interrupted.");
  }
}

/**
 * 独立于 Agent loop 的小型状态图。普通聊天不需要它；有分支、恢复或人工审批时再使用。
 */
export class StateGraph<TState extends GraphState> {
  private readonly nodes = new Map<string, GraphNode<TState>>();
  private readonly edges = new Map<string, Edge<TState>[]>();
  private startNode?: string;

  constructor(
    private readonly reducer: (
      state: Readonly<TState>,
      updates: readonly Partial<TState>[],
    ) => TState = defaultReducer,
    private readonly checkpoints?: GraphCheckpointStore<TState>,
  ) {}

  addNode(name: string, node: GraphNode<TState>): this {
    if (this.nodes.has(name)) throw new Error(`Graph node already exists: ${name}`);
    this.nodes.set(name, node);
    return this;
  }

  addEdge(
    from: string,
    to: string,
    when?: (state: Readonly<TState>) => boolean,
  ): this {
    const edges = this.edges.get(from) ?? [];
    edges.push({ to, ...(when ? { when } : {}) });
    this.edges.set(from, edges);
    return this;
  }

  setStart(name: string): this {
    this.startNode = name;
    return this;
  }

  async run(
    initialState: TState,
    options: {
      checkpointId?: string;
      resume?: boolean;
      resumeValue?: unknown;
      signal?: AbortSignal;
      maxSteps?: number;
    } = {},
  ): Promise<GraphRunResult<TState>> {
    const saved = options.resume && options.checkpointId
      ? await this.checkpoints?.load(options.checkpointId)
      : undefined;
    let state = structuredClone(saved?.state ?? initialState);
    let current: string | undefined = saved?.nextNode ?? this.startNode;
    let steps = saved?.steps ?? 0;
    let pendingResumeValue = options.resumeValue;
    if (!current) throw new Error("Graph start node is not configured.");
    const maxSteps = options.maxSteps ?? 100;

    while (current) {
      if (steps >= maxSteps) throw new Error(`Graph exceeded ${maxSteps} steps.`);
      if (options.signal?.aborted) throw abortError(options.signal);
      const node = this.nodes.get(current);
      if (!node) throw new Error(`Unknown graph node: ${current}`);
      try {
        const output = await node(structuredClone(state), {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(pendingResumeValue !== undefined ? { resumeValue: pendingResumeValue } : {}),
          interrupt(value): never { throw new GraphInterrupt(value); },
        });
        // resumeValue 只属于恢复的那个节点，不能泄漏到后续节点。
        pendingResumeValue = undefined;
        steps += 1;
        if (isFork(output)) {
          const updates = await Promise.all(output.fork.map(async (name) => {
            const branch = this.nodes.get(name);
            if (!branch) throw new Error(`Unknown graph node: ${name}`);
            const result = await branch(structuredClone(state), {
              ...(options.signal ? { signal: options.signal } : {}),
              interrupt(): never {
                throw new Error("Fork branches cannot interrupt; interrupt before or after the fork.");
              },
            });
            if (!result || isFork(result)) {
              throw new Error("Fork branches must return state updates.");
            }
            return result;
          }));
          state = this.reducer(state, updates);
          current = output.join;
        } else {
          if (output) state = this.reducer(state, [output]);
          current = this.next(current, state);
        }
        await this.save(options.checkpointId, { state, nextNode: current ?? "", steps });
      } catch (error) {
        if (!(error instanceof GraphInterrupt)) throw error;
        await this.save(options.checkpointId, {
          state,
          nextNode: current ?? "",
          steps,
          interruptValue: error.value,
        });
        return { status: "interrupted", state, steps, value: error.value };
      }
    }
    if (options.checkpointId) await this.checkpoints?.clear(options.checkpointId);
    return { status: "completed", state, steps };
  }

  private next(from: string, state: Readonly<TState>): string | undefined {
    return this.edges.get(from)?.find((edge) => !edge.when || edge.when(state))?.to;
  }

  private async save(
    id: string | undefined,
    checkpoint: GraphCheckpoint<TState>,
  ): Promise<void> {
    if (id) await this.checkpoints?.save(id, checkpoint);
  }
}

function isFork<TState extends GraphState>(
  value: Partial<TState> | GraphFork | void,
): value is GraphFork {
  return Boolean(value && "fork" in value && "join" in value);
}

function defaultReducer<TState extends GraphState>(
  state: Readonly<TState>,
  updates: readonly Partial<TState>[],
): TState {
  return Object.assign({}, state, ...updates) as TState;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Graph aborted.");
}
