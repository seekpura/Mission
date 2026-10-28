import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubCapabilityClient } from "../../src/runtime/github-capability-client.ts";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const SKILL_BLOB_SHA = "c".repeat(40);
const README_BLOB_SHA = "d".repeat(40);
const SKILL = "# Skill\nDo the verified thing.\n";
const README = "fixture\n";

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function fixtureFetch(options: { tree?: unknown; includeCodeSearch?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.headers && (init.headers as Record<string, string>)["user-agent"], "mission-runtime-capability-transport");
    if (url.pathname === "/search/repositories") {
      return json({ items: [{
        full_name: "example/skill",
        description: "Agent skill for verified work",
        html_url: "https://github.com/example/skill",
        default_branch: "main",
        stargazers_count: 42
      }] });
    }
    if (url.pathname === "/search/code") {
      if (!options.includeCodeSearch) return json({ items: [] });
      return json({ items: [
        { path: "SKILL.md", repository: { full_name: "example/skill", html_url: "https://github.com/example/skill" } },
        { path: "nested/SKILL.md", repository: { full_name: "example/skill", html_url: "https://github.com/example/skill" } }
      ] });
    }
    if (url.pathname === "/repos/example/skill") {
      return json({
        full_name: "example/skill",
        description: "Agent skill for verified work",
        html_url: "https://github.com/example/skill",
        default_branch: "main",
        stargazers_count: 42
      });
    }
    if (url.pathname === "/repos/example/skill/commits/main") {
      return json({ sha: COMMIT_SHA, commit: { tree: { sha: TREE_SHA } } });
    }
    if (url.pathname === `/repos/example/skill/git/trees/${TREE_SHA}`) {
      return json(options.tree ?? {
        truncated: false,
        tree: [
          { path: "SKILL.md", mode: "100644", type: "blob", sha: SKILL_BLOB_SHA, size: Buffer.byteLength(SKILL) },
          { path: "README.md", mode: "100644", type: "blob", sha: README_BLOB_SHA, size: Buffer.byteLength(README) }
        ]
      });
    }
    if (url.pathname === `/repos/example/skill/git/blobs/${SKILL_BLOB_SHA}`) {
      return json({ encoding: "base64", content: Buffer.from(SKILL).toString("base64"), size: Buffer.byteLength(SKILL) });
    }
    if (url.pathname === `/repos/example/skill/git/blobs/${README_BLOB_SHA}`) {
      return json({ encoding: "base64", content: Buffer.from(README).toString("base64"), size: Buffer.byteLength(README) });
    }
    throw new Error(`Unexpected GitHub fixture request: ${url.pathname}${url.search}`);
  }) as typeof fetch;
}

test("GitHub capability client searches, pins an immutable commit and materializes exact blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-github-client-"));
  try {
    const client = new GitHubCapabilityClient({ fetchImpl: fixtureFetch() });
    const repos = await client.searchRepositories("verified skill", 8);
    assert.deepEqual(repos, [{
      fullName: "example/skill",
      description: "Agent skill for verified work",
      url: "https://github.com/example/skill",
      defaultBranch: "main",
      stars: 42
    }]);

    const snapshot = await client.snapshot({
      sourceUri: "https://github.com/example/skill",
      targetDirectory: root
    });
    assert.equal(snapshot.resolvedRevision, COMMIT_SHA);
    assert.equal(await readFile(join(root, "SKILL.md"), "utf8"), SKILL);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), README);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Agent Skill code search deduplicates repository candidates and is disabled without authentication", async () => {
  const unauthenticated = new GitHubCapabilityClient({ fetchImpl: fixtureFetch({ includeCodeSearch: true }) });
  assert.deepEqual(await unauthenticated.find("verified skill", 8), []);

  const authenticated = new GitHubCapabilityClient({
    token: "test-token",
    fetchImpl: fixtureFetch({ includeCodeSearch: true })
  });
  const skills = await authenticated.find("verified skill", 8);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "example/skill");
  assert.equal(skills[0]?.sourceUri, "https://github.com/example/skill");
});

test("GitHub capability client refuses truncated trees, submodules and unsafe repository paths before blob materialization", async () => {
  const cases = [
    {
      label: "truncated",
      tree: { truncated: true, tree: [] },
      pattern: /tree is truncated/
    },
    {
      label: "submodule",
      tree: { truncated: false, tree: [{ path: "vendor/tool", mode: "160000", type: "commit", sha: "e".repeat(40) }] },
      pattern: /submodule/
    },
    {
      label: "unsafe-path",
      tree: { truncated: false, tree: [{ path: "../escape", mode: "100644", type: "blob", sha: SKILL_BLOB_SHA, size: 1 }] },
      pattern: /Unsafe GitHub repository path/
    }
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `mission-github-${item.label}-`));
    try {
      const client = new GitHubCapabilityClient({ fetchImpl: fixtureFetch({ tree: item.tree }) });
      await assert.rejects(
        client.snapshot({ sourceUri: "https://github.com/example/skill", targetDirectory: root }),
        item.pattern
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("GitHub capability client refuses non-canonical repository URLs", async () => {
  const client = new GitHubCapabilityClient({ fetchImpl: fixtureFetch() });
  const root = await mkdtemp(join(tmpdir(), "mission-github-url-"));
  try {
    await assert.rejects(
      client.snapshot({ sourceUri: "https://github.com/example/skill/tree/main", targetDirectory: root }),
      /must identify one repository/
    );
    await assert.rejects(
      client.snapshot({ sourceUri: "https://evil.example/example/skill", targetDirectory: root }),
      /Only canonical/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
