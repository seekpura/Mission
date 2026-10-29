import assert from "node:assert/strict";
import test from "node:test";
import { validateStructuredProviderObservation } from "../../src/runtime/provider-evidence-observation.ts";

test("provider evidence observation schemas accept the minimum truthful shape for every production kind", () => {
  const cases: Array<[Parameters<typeof validateStructuredProviderObservation>[0], unknown]> = [
    ["presentation-render", { renderedUnits: 12, renderFailureCount: 0 }],
    ["browser-runtime", { loaded: true, blockingErrorCount: 0, interactions: ["navigation"] }],
    ["accessibility-check", { checkedNodeCount: 120, violationCount: 2, blockingViolationCount: 0 }],
    ["media-probe", { durationMs: 12_500, streamCount: 2 }],
    ["media-playback", { playedToEnd: true, playbackErrorCount: 0 }],
    ["executable-test", { passed: true, exitCode: 0 }],
    ["build-check", { passed: true, exitCode: 0 }],
    ["integration-test", { passed: true, exitCode: 0 }],
    ["source-recency", {
      checkedSourceCount: 6,
      freshSourceCount: 6,
      staleSourceCount: 0,
      asOf: "2026-10-29T00:00:00.000Z"
    }]
  ];

  for (const [kind, observation] of cases) {
    assert.deepEqual(validateStructuredProviderObservation(kind, "supports", observation), observation, kind);
  }
});

test("provider evidence observation schemas reject semantic contradictions instead of trusting the verdict label", () => {
  const cases: Array<[Parameters<typeof validateStructuredProviderObservation>[0], unknown, RegExp]> = [
    ["presentation-render", { renderedUnits: 12, renderFailureCount: 1 }, /cannot support/],
    ["browser-runtime", { loaded: false, blockingErrorCount: 0 }, /supports requires loaded=true/],
    ["accessibility-check", { checkedNodeCount: 120, violationCount: 2, blockingViolationCount: 1 }, /cannot support/],
    ["media-playback", { playedToEnd: true, playbackErrorCount: 2 }, /supports requires playedToEnd=true/],
    ["executable-test", { passed: false, exitCode: 1 }, /supports requires passed=true/],
    ["build-check", { passed: false, exitCode: 1 }, /supports requires passed=true/],
    ["integration-test", { passed: false, exitCode: 1 }, /supports requires passed=true/],
    ["source-recency", {
      checkedSourceCount: 6,
      freshSourceCount: 5,
      staleSourceCount: 1,
      asOf: "2026-10-29T00:00:00.000Z"
    }, /cannot support/]
  ];

  for (const [kind, observation, pattern] of cases) {
    assert.throws(() => validateStructuredProviderObservation(kind, "supports", observation), pattern, kind);
  }

  assert.throws(
    () => validateStructuredProviderObservation("executable-test", "contradicts", { passed: true, exitCode: 0 }),
    /contradicts cannot report passed=true/
  );
});

test("provider evidence observation schemas reject missing and internally inconsistent fields", () => {
  assert.throws(
    () => validateStructuredProviderObservation("browser-runtime", "supports", { loaded: true }),
    /blockingErrorCount is required/
  );
  assert.throws(
    () => validateStructuredProviderObservation("accessibility-check", "supports", {
      checkedNodeCount: 10,
      violationCount: 1,
      blockingViolationCount: 2
    }),
    /cannot exceed violationCount/
  );
  assert.throws(
    () => validateStructuredProviderObservation("source-recency", "supports", {
      checkedSourceCount: 2,
      freshSourceCount: 2,
      staleSourceCount: 1,
      asOf: "2026-10-29T00:00:00.000Z"
    }),
    /cannot exceed checkedSourceCount/
  );
  assert.throws(
    () => validateStructuredProviderObservation("media-probe", "supports", { durationMs: 0, streamCount: 1 }),
    /durationMs must be a positive finite number/
  );
});

test("inconclusive provider evidence may omit observation but non-inconclusive evidence may not", () => {
  assert.equal(validateStructuredProviderObservation("browser-runtime", "inconclusive", undefined), undefined);
  assert.throws(
    () => validateStructuredProviderObservation("browser-runtime", "supports", undefined),
    /requires an observation/
  );
});
