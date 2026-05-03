import { describe, expect, it } from "bun:test";
import {
  createClaudeAcpAgentProvider,
  createCodexAcpAgentProvider,
  createPiAcpAgentProvider,
} from "./index";

describe("ACP agent providers", () => {
  it("creates the built-in provider runtimes", () => {
    const claude = createClaudeAcpAgentProvider();
    const codex = createCodexAcpAgentProvider();
    const pi = createPiAcpAgentProvider();

    expect(claude.runtime.name).toBe("claude");
    expect(codex.runtime.name).toBe("codex");
    expect(pi.runtime.name).toBe("pi");
    expect(claude.description).toBe("Claude ACP provider");
    expect(codex.description).toBe("Codex ACP provider");
    expect(pi.description).toBe("Pi ACP provider");
    expect(pi.process).toEqual({ command: "pi-acp", args: [], env: undefined });
  });

  it("allows process overrides", () => {
    const provider = createCodexAcpAgentProvider({
      process: { command: "custom-acp", args: ["--stdio"], env: { A: "B" } },
    });

    expect(provider.process).toEqual({ command: "custom-acp", args: ["--stdio"], env: { A: "B" } });
  });
});
