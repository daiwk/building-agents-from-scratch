import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "tools/list") {
    result = { tools: [{
      name: "echo",
      description: "Echo one value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    }] };
  } else if (request.method === "tools/call") {
    result = { content: request.params.arguments.value };
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: request.id, result,
  }) + "\n");
});
