import test from "node:test";
import assert from "node:assert/strict";
import { AgentSkillsCliClient, parseAgentSkillsFindOutput } from "../../src/core/capabilities/providers/agent-skills-cli-client.ts";
import { GitHubRestSearchClient } from "../../src/core/capabilities/providers/github-rest-client.ts";

class FakeProcessManager {
  private readonly stdout: string;
  constructor(stdout: string) { this.stdout = stdout; }
  async run(spec: any) {
    assert.equal(spec.command, process.platform === "win32" ? "npx.cmd" : "npx");
    assert.deepEqual(spec.args.slice(0, 3), ["--yes", "skills@1.7.4", "find"]);
    assert.equal(spec.env.DISABLE_TELEMETRY, "1");
    return { exitCode: 0, stdout: this.stdout, stderr: "", timedOut: false };
  }
}

test("Agent Skills parser extracts repo@skill and direct tree results without treating prose as candidates", () => {
  const output = `\nFound skills:\n  vercel-labs/agent-skills@frontend-design\n  https://github.com/acme/skills/tree/main/skills/research-pro\nRun npx skills add ...\n`;
  const parsed = parseAgentSkillsFindOutput(output);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(x => x.name).sort(), ["frontend-design", "research-pro"]);
  assert.equal(parsed.find(x => x.name === "frontend-design")?.sourceUri, "https://github.com/vercel-labs/agent-skills");
  assert.equal(parsed.find(x => x.name === "research-pro")?.sourceUri, "https://github.com/acme/skills/tree/main/skills/research-pro");
});

test("Agent Skills CLI client pins the package version used for discovery and does not install capabilities", async () => {
  const client = new AgentSkillsCliClient({ processManager: new FakeProcessManager("owner/repo@skill-one\n") as any });
  const result = await client.find("diagram animation", 5);
  assert.equal(result[0]?.name, "skill-one");
  assert.equal(client.packageVersion, "1.7.4");
});

test("GitHub REST client searches repository metadata with bounded result count and auth header", async () => {
  let requestedUrl = "";
  let authorization = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      items: [
        { full_name: "owner/repo", description: "motion skill", html_url: "https://github.com/owner/repo", default_branch: "main", stargazers_count: 42 },
        { full_name: "owner/other", description: null, html_url: "https://github.com/owner/other", default_branch: "master", stargazers_count: 2 }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new GitHubRestSearchClient({ token: "secret", fetchImpl: fakeFetch });
  const result = await client.searchRepositories("svg animation", 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.fullName, "owner/repo");
  assert.match(requestedUrl, /search\/repositories/);
  assert.match(requestedUrl, /per_page=1/);
  assert.equal(authorization, "Bearer secret");
});
