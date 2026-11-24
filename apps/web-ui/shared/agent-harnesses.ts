export const agentHarnesses = {
  "claude-code": { title: "Claude Code", executable: "claude" },
  codex: { title: "Codex", executable: "codex" },
  pi: { title: "Pi", executable: "pi" },
  opencode: { title: "OpenCode", executable: "opencode" },
};

export type AgentHarness = keyof typeof agentHarnesses;

export function isAgentHarness(value: unknown): value is AgentHarness {
  return typeof value === "string" && Object.hasOwn(agentHarnesses, value);
}
