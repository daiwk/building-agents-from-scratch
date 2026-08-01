import type {
  AgentBudget,
  BudgetSnapshot,
  TokenPricing,
  TokenUsage,
} from "./types.js";

export type BudgetMetric =
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "cost";

/** 下一次模型调用会越过已经耗尽的预算。 */
export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";

  constructor(
    readonly metric: BudgetMetric,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(
      `Agent budget exhausted: ${metric} is ${formatNumber(actual)}, ` +
        `limit is ${formatNumber(limit)}.`,
    );
  }
}

/** 启用了预算，但 provider 没有返回 usage，无法安全继续计量。 */
export class BudgetUsageUnavailableError extends Error {
  override readonly name = "BudgetUsageUnavailableError";

  constructor() {
    super(
      "Agent budget requires token usage, but the model provider did not return it.",
    );
  }
}

/**
 * 累计一次 Agent run 中的 token 和估算成本。
 *
 * Tracker 不调用模型，也不修改 Context。Agent loop 只在下一次模型调用前询问它是否
 * 还能继续，因此最后一次调用可能略微超过上限，但绝不会再启动额外模型调用。
 */
export class BudgetTracker {
  private readonly options: AgentBudget;
  private readonly pricing: TokenPricing | undefined;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private estimatedCost = 0;

  constructor(options: AgentBudget = {}) {
    validateBudget(options);
    this.options = options;
    this.pricing = options.pricing;
  }

  get requiresUsage(): boolean {
    return (
      this.options.maxInputTokens !== undefined ||
      this.options.maxOutputTokens !== undefined ||
      this.options.maxTotalTokens !== undefined ||
      this.options.maxCost !== undefined
    );
  }

  record(usage: TokenUsage): BudgetSnapshot {
    validateUsage(usage);
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.cacheReadTokens += cacheRead;
    this.cacheWriteTokens += cacheWrite;
    if (this.pricing) {
      this.estimatedCost += estimateCost(usage, this.pricing);
    }
    return this.snapshot();
  }

  snapshot(): BudgetSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      totalTokens:
        this.inputTokens +
        this.outputTokens +
        this.cacheReadTokens +
        this.cacheWriteTokens,
      ...(this.pricing
        ? {
            estimatedCost: this.estimatedCost,
            currency: this.pricing.currency,
          }
        : {}),
    };
  }

  assertCanStartModelCall(): void {
    const snapshot = this.snapshot();
    assertBelow(
      "inputTokens",
      snapshot.inputTokens,
      this.options.maxInputTokens,
    );
    assertBelow(
      "outputTokens",
      snapshot.outputTokens,
      this.options.maxOutputTokens,
    );
    assertBelow(
      "totalTokens",
      snapshot.totalTokens,
      this.options.maxTotalTokens,
    );
    assertBelow("cost", this.estimatedCost, this.options.maxCost);
  }
}

/**
 * 把 .env 中的 AGENT_* 字段翻译为强类型配置。
 *
 * 单独导出这个函数，是为了让 from-scratch、CLI/Web 和 pi-agent 对照版复用同一套
 * 配置语义，而不是在三个入口各写一份容易漂移的解析代码。
 */
export function createBudgetFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentBudget | undefined {
  const value = (name: string) => environment[name]?.trim();
  const has = (name: string) => Boolean(value(name));
  const limitNames = [
    "AGENT_MAX_INPUT_TOKENS",
    "AGENT_MAX_OUTPUT_TOKENS",
    "AGENT_MAX_TOTAL_TOKENS",
    "AGENT_MAX_COST",
  ];
  if (!limitNames.some(has)) return undefined;

  const readNumber = (name: string): number | undefined => {
    const raw = value(name);
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${name} must be a non-negative number.`);
    }
    return parsed;
  };
  const readInteger = (name: string): number | undefined => {
    const parsed = readNumber(name);
    if (parsed !== undefined && !Number.isInteger(parsed)) {
      throw new Error(`${name} must be an integer.`);
    }
    return parsed;
  };
  const inputRate = readNumber("AGENT_INPUT_COST_PER_MILLION_TOKENS");
  const outputRate = readNumber("AGENT_OUTPUT_COST_PER_MILLION_TOKENS");
  if ((inputRate === undefined) !== (outputRate === undefined)) {
    throw new Error("Input and output token prices must be configured together.");
  }

  let pricing: TokenPricing | undefined;
  if (inputRate !== undefined && outputRate !== undefined) {
    const currency = value("AGENT_COST_CURRENCY");
    if (!currency) throw new Error("AGENT_COST_CURRENCY is required.");
    pricing = {
      currency,
      inputCostPerMillionTokens: inputRate,
      outputCostPerMillionTokens: outputRate,
      ...optionalValue(
        "cacheReadCostPerMillionTokens",
        readNumber("AGENT_CACHE_READ_COST_PER_MILLION_TOKENS"),
      ),
      ...optionalValue(
        "cacheWriteCostPerMillionTokens",
        readNumber("AGENT_CACHE_WRITE_COST_PER_MILLION_TOKENS"),
      ),
    };
  }
  const maxCost = readNumber("AGENT_MAX_COST");
  if (maxCost !== undefined && !pricing) {
    throw new Error(
      "AGENT_MAX_COST requires input/output token prices and a currency.",
    );
  }

  return {
    ...optionalValue("maxInputTokens", readInteger("AGENT_MAX_INPUT_TOKENS")),
    ...optionalValue("maxOutputTokens", readInteger("AGENT_MAX_OUTPUT_TOKENS")),
    ...optionalValue("maxTotalTokens", readInteger("AGENT_MAX_TOTAL_TOKENS")),
    ...optionalValue("maxCost", maxCost),
    ...(pricing ? { pricing } : {}),
  };
}

function estimateCost(usage: TokenUsage, pricing: TokenPricing): number {
  // cache rate 未显式填写时按普通 input rate 估算，宁可保守也不默认为免费。
  const cacheReadRate =
    pricing.cacheReadCostPerMillionTokens ??
    pricing.inputCostPerMillionTokens;
  const cacheWriteRate =
    pricing.cacheWriteCostPerMillionTokens ??
    pricing.inputCostPerMillionTokens;
  return (
    usage.input * pricing.inputCostPerMillionTokens +
    usage.output * pricing.outputCostPerMillionTokens +
    (usage.cacheRead ?? 0) * cacheReadRate +
    (usage.cacheWrite ?? 0) * cacheWriteRate
  ) / 1_000_000;
}

function assertBelow(
  metric: BudgetMetric,
  actual: number,
  limit: number | undefined,
): void {
  if (limit !== undefined && actual >= limit) {
    throw new BudgetExceededError(metric, limit, actual);
  }
}

function validateBudget(options: AgentBudget): void {
  validateOptionalInteger(options.maxInputTokens, "maxInputTokens");
  validateOptionalInteger(options.maxOutputTokens, "maxOutputTokens");
  validateOptionalInteger(options.maxTotalTokens, "maxTotalTokens");
  validateOptionalNumber(options.maxCost, "maxCost");
  if (options.maxCost !== undefined && !options.pricing) {
    throw new Error("maxCost requires provider-specific token pricing.");
  }
  if (options.pricing) {
    validateOptionalNumber(
      options.pricing.inputCostPerMillionTokens,
      "inputCostPerMillionTokens",
    );
    validateOptionalNumber(
      options.pricing.outputCostPerMillionTokens,
      "outputCostPerMillionTokens",
    );
    validateOptionalNumber(
      options.pricing.cacheReadCostPerMillionTokens,
      "cacheReadCostPerMillionTokens",
    );
    validateOptionalNumber(
      options.pricing.cacheWriteCostPerMillionTokens,
      "cacheWriteCostPerMillionTokens",
    );
    if (!options.pricing.currency.trim()) {
      throw new Error("pricing.currency cannot be empty.");
    }
  }
}

function validateUsage(usage: TokenUsage): void {
  validateOptionalInteger(usage.input, "usage.input");
  validateOptionalInteger(usage.output, "usage.output");
  validateOptionalInteger(usage.cacheRead, "usage.cacheRead");
  validateOptionalInteger(usage.cacheWrite, "usage.cacheWrite");
}

function validateOptionalInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function validateOptionalNumber(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}

function optionalValue<Key extends string>(
  key: Key,
  value: number | undefined,
): { [Property in Key]?: number } {
  return (value === undefined ? {} : { [key]: value }) as {
    [Property in Key]?: number;
  };
}
