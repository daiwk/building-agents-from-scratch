import type {
  AssistantMessage,
  ModelProvider,
  ModelRequest,
  TokenUsage,
} from "../core/index.js";

export type ModelRole = "generator" | "judge";
export type RoutingContext = { task: string; role?: ModelRole; preferredModel?: string };
export type ModelRoute = {
  name: string;
  model: ModelProvider;
  when?: (context: Readonly<RoutingContext>) => boolean;
};
export type ModelRouteMetric = {
  role: ModelRole;
  model: string;
  requests: number;
  successes: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
};

/** 显式规则路由；fallback 只处理调用失败，generator 与 judge 分开计量。 */
export class ModelRouter {
  private readonly metrics = new Map<string, ModelRouteMetric>();

  constructor(private readonly routes: readonly ModelRoute[]) {
    if (routes.length === 0) throw new Error("ModelRouter needs at least one route.");
    const names = routes.map((route) => route.name);
    if (new Set(names).size !== names.length) throw new Error("Model route names must be unique.");
  }

  async generate(
    request: ModelRequest,
    context: RoutingContext,
  ): Promise<AssistantMessage & { routedModel?: string }> {
    const candidates = this.candidates(context);
    const failures: string[] = [];
    for (const route of candidates) {
      const metric = this.metric(context.role ?? "generator", route.name);
      metric.requests += 1;
      try {
        const message = await route.model.generate(request);
        metric.successes += 1;
        addUsage(metric, message.usage);
        return Object.assign(message, { routedModel: route.name });
      } catch (error) {
        metric.failures += 1;
        failures.push(`${route.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new AggregateError([], `All routed models failed: ${failures.join(" | ")}`);
  }

  asProvider(context: RoutingContext): ModelProvider {
    return { name: "model-router", generate: (request) => this.generate(request, context) };
  }

  snapshotMetrics(): ModelRouteMetric[] {
    return [...this.metrics.values()].map((metric) => ({ ...metric }));
  }

  private candidates(context: RoutingContext): ModelRoute[] {
    const preferred = context.preferredModel
      ? this.routes.find((route) => route.name === context.preferredModel)
      : undefined;
    if (context.preferredModel && !preferred) {
      throw new Error(`Unknown preferred model: ${context.preferredModel}`);
    }
    const matched = this.routes.filter((route) => route.when?.(context) ?? true);
    return preferred ? [preferred, ...matched.filter((route) => route !== preferred)] : matched;
  }

  private metric(role: ModelRole, model: string): ModelRouteMetric {
    const key = `${role}:${model}`;
    let metric = this.metrics.get(key);
    if (!metric) {
      metric = { role, model, requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
      this.metrics.set(key, metric);
    }
    return metric;
  }
}

function addUsage(metric: ModelRouteMetric, usage?: TokenUsage): void {
  metric.inputTokens += usage?.input ?? 0;
  metric.outputTokens += usage?.output ?? 0;
}
