import type { Tool } from "../core/index.js";

const operations = ["add", "subtract", "multiply", "divide"] as const;
type Operation = (typeof operations)[number];

export const calculatorTool: Tool = {
  name: "calculator",
  description: "Perform one exact arithmetic operation on two numbers.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [...operations],
        description: "The arithmetic operation.",
      },
      left: { type: "number", description: "Left operand." },
      right: { type: "number", description: "Right operand." },
    },
    required: ["operation", "left", "right"],
    additionalProperties: false,
  },
  execute(input) {
    const operation = input.operation;
    const left = input.left;
    const right = input.right;
    if (
      typeof operation !== "string" ||
      !operations.includes(operation as Operation) ||
      typeof left !== "number" ||
      typeof right !== "number"
    ) {
      throw new Error("Expected operation, left, and right.");
    }

    if (operation === "add") return String(left + right);
    if (operation === "subtract") return String(left - right);
    if (operation === "multiply") return String(left * right);
    if (right === 0) throw new Error("Cannot divide by zero.");
    return String(left / right);
  },
};
