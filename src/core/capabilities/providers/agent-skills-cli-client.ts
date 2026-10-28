import type { AgentSkillsClient, AgentSkillsSearchResult } from "./agent-skills-provider.ts";
import { ProcessManager } from "../../../execution/local/process-manager.ts";

export interface AgentSkillsCliClientOptions {
  packageVersion?: string;
  timeoutMs?: number;
  processManager?: ProcessManager;
  command?: string;
}

/** Discovery adapter for the Vercel Agent Skills CLI. It uses find only. */
export class AgentSkillsCliClient implements AgentSkillsClient {
  readonly packageVersion: string;
  private readonly timeoutMs: number;
  private readonly processes: ProcessManager;
  private readonly command: string;

  constructor(options: AgentSkillsCliClientOptions = {}) {
    this.packageVersion = options.packageVersion ?? "1.7.4";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.processes = options.processManager ?? new ProcessManager();
    this.command = options.command ?? (process.platform === "win32" ? "npx.cmd" : "npx");
  }

  async find(query: string, limit: number): Promise<AgentSkillsSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const result = await this.processes.run({
      command: this.command,
      args: ["--yes", `skills@${this.packageVersion}`, "find", trimmed],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
        CI: "1"
      },
      timeoutMs: this.timeoutMs
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Agent Skills discovery failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
    return parseAgentSkillsFindOutput(result.stdout).slice(0, Math.max(1, limit));
  }
}

export function parseAgentSkillsFindOutput(output: string): AgentSkillsSearchResult[] {
  const results = new Map<string, AgentSkillsSearchResult>();
  const ansi = /\u001b\[[0-9;]*m/g;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ansi, "").trim();
    if (!line) continue;
    for (const match of line.matchAll(/(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)/g)) {
      const owner = match[1]!;
      const repo = match[2]!.replace(/\.git$/i, "");
      const skillName = match[3]!;
      const key = `${owner}/${repo}@${skillName}`.toLowerCase();
      results.set(key, {
        name: skillName,
        sourceUri: `https://github.com/${owner}/${repo}`,
        description: `Agent Skill ${skillName} from ${owner}/${repo}`
      });
    }
    for (const match of line.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/([^/\s]+)\/([^\s)]+)/g)) {
      const owner = match[1]!;
      const repo = match[2]!.replace(/\.git$/i, "");
      const ref = match[3]!;
      const path = match[4]!.replace(/[),.;]+$/, "");
      const skillName = path.split("/").filter(Boolean).at(-1) ?? repo;
      const key = `${owner}/${repo}@${skillName}`.toLowerCase();
      results.set(key, {
        name: skillName,
        sourceUri: `https://github.com/${owner}/${repo}/tree/${ref}/${path}`,
        revision: ref,
        description: `Agent Skill ${skillName} from ${owner}/${repo}`
      });
    }
  }
  return [...results.values()];
}
