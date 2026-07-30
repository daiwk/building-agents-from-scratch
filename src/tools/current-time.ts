import type { Tool } from "../core/index.js";

export const currentTimeTool: Tool = {
  name: "current_time",
  description: "Get the current time in an IANA time zone.",
  inputSchema: {
    type: "object",
    properties: {
      timeZone: {
        type: "string",
        description: "IANA time zone, for example Asia/Shanghai.",
      },
    },
    required: ["timeZone"],
    additionalProperties: false,
  },
  execute(input) {
    if (typeof input.timeZone !== "string") {
      throw new Error("timeZone must be a string.");
    }
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: input.timeZone,
      }).format(new Date());
    } catch {
      throw new Error(`Invalid IANA time zone: ${input.timeZone}`);
    }
  },
};
