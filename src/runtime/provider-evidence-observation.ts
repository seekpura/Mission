import type { Evidence, VerificationEvidenceKind } from "../core/domain/verification.ts";

export function validateStructuredProviderObservation(
  kind: VerificationEvidenceKind,
  result: Evidence["result"],
  value: unknown
): unknown | undefined {
  if (value === undefined) {
    if (result === "inconclusive") return undefined;
    throw new Error(`Provider evidence ${kind} requires an observation for ${result} result`);
  }
  const observation = objectValue(value, `Provider evidence ${kind} observation`);

  switch (kind) {
    case "presentation-render": {
      const renderedUnits = positiveInteger(observation, "renderedUnits", kind);
      const renderFailureCount = nonNegativeInteger(observation, "renderFailureCount", kind);
      if (result === "supports" && renderFailureCount !== 0) {
        throw new Error(`Provider evidence ${kind} cannot support with renderFailureCount=${renderFailureCount}`);
      }
      return { renderedUnits, renderFailureCount };
    }
    case "browser-runtime": {
      const loaded = booleanValue(observation, "loaded", kind);
      const blockingErrorCount = nonNegativeInteger(observation, "blockingErrorCount", kind);
      const interactions = optionalStringArray(observation, "interactions", kind);
      if (result === "supports" && (!loaded || blockingErrorCount !== 0)) {
        throw new Error(`Provider evidence ${kind} supports requires loaded=true and blockingErrorCount=0`);
      }
      return {
        loaded,
        blockingErrorCount,
        ...(interactions === undefined ? {} : { interactions })
      };
    }
    case "accessibility-check": {
      const checkedNodeCount = nonNegativeInteger(observation, "checkedNodeCount", kind);
      const violationCount = nonNegativeInteger(observation, "violationCount", kind);
      const blockingViolationCount = nonNegativeInteger(observation, "blockingViolationCount", kind);
      if (blockingViolationCount > violationCount) {
        throw new Error(`Provider evidence ${kind} blockingViolationCount cannot exceed violationCount`);
      }
      if (result === "supports" && blockingViolationCount !== 0) {
        throw new Error(`Provider evidence ${kind} cannot support with blocking accessibility violations`);
      }
      return { checkedNodeCount, violationCount, blockingViolationCount };
    }
    case "media-probe": {
      const durationMs = positiveFiniteNumber(observation, "durationMs", kind);
      const streamCount = positiveInteger(observation, "streamCount", kind);
      return { durationMs, streamCount };
    }
    case "media-playback": {
      const playedToEnd = booleanValue(observation, "playedToEnd", kind);
      const playbackErrorCount = nonNegativeInteger(observation, "playbackErrorCount", kind);
      if (result === "supports" && (!playedToEnd || playbackErrorCount !== 0)) {
        throw new Error(`Provider evidence ${kind} supports requires playedToEnd=true and playbackErrorCount=0`);
      }
      return { playedToEnd, playbackErrorCount };
    }
    case "executable-test":
    case "build-check":
    case "integration-test": {
      const passed = booleanValue(observation, "passed", kind);
      const exitCode = integerValue(observation, "exitCode", kind);
      if (result === "supports" && (!passed || exitCode !== 0)) {
        throw new Error(`Provider evidence ${kind} supports requires passed=true and exitCode=0`);
      }
      if (result === "contradicts" && passed && exitCode === 0) {
        throw new Error(`Provider evidence ${kind} contradicts cannot report passed=true and exitCode=0`);
      }
      return { passed, exitCode };
    }
    case "source-recency": {
      const checkedSourceCount = positiveInteger(observation, "checkedSourceCount", kind);
      const freshSourceCount = nonNegativeInteger(observation, "freshSourceCount", kind);
      const staleSourceCount = nonNegativeInteger(observation, "staleSourceCount", kind);
      if (freshSourceCount + staleSourceCount > checkedSourceCount) {
        throw new Error(`Provider evidence ${kind} freshSourceCount + staleSourceCount cannot exceed checkedSourceCount`);
      }
      const asOf = timestampValue(observation, "asOf", kind);
      if (result === "supports" && staleSourceCount !== 0) {
        throw new Error(`Provider evidence ${kind} cannot support while staleSourceCount is non-zero`);
      }
      return { checkedSourceCount, freshSourceCount, staleSourceCount, asOf };
    }
    default:
      throw new Error(`Provider evidence kind ${kind} has no structured observation schema`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function field(object: Record<string, unknown>, name: string, kind: string): unknown {
  if (!(name in object)) throw new Error(`Provider evidence ${kind} observation.${name} is required`);
  return object[name];
}

function booleanValue(object: Record<string, unknown>, name: string, kind: string): boolean {
  const value = field(object, name, kind);
  if (typeof value !== "boolean") throw new Error(`Provider evidence ${kind} observation.${name} must be boolean`);
  return value;
}

function integerValue(object: Record<string, unknown>, name: string, kind: string): number {
  const value = field(object, name, kind);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Provider evidence ${kind} observation.${name} must be an integer`);
  }
  return value;
}

function nonNegativeInteger(object: Record<string, unknown>, name: string, kind: string): number {
  const value = integerValue(object, name, kind);
  if (value < 0) throw new Error(`Provider evidence ${kind} observation.${name} must be non-negative`);
  return value;
}

function positiveInteger(object: Record<string, unknown>, name: string, kind: string): number {
  const value = integerValue(object, name, kind);
  if (value <= 0) throw new Error(`Provider evidence ${kind} observation.${name} must be positive`);
  return value;
}

function positiveFiniteNumber(object: Record<string, unknown>, name: string, kind: string): number {
  const value = field(object, name, kind);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Provider evidence ${kind} observation.${name} must be a positive finite number`);
  }
  return value;
}

function optionalStringArray(
  object: Record<string, unknown>,
  name: string,
  kind: string
): string[] | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== "string" || !item.trim() || item.length > 256)) {
    throw new Error(`Provider evidence ${kind} observation.${name} must be an array of bounded non-empty strings`);
  }
  return value.map(item => (item as string).trim());
}

function timestampValue(object: Record<string, unknown>, name: string, kind: string): string {
  const value = field(object, name, kind);
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Provider evidence ${kind} observation.${name} must be a valid timestamp`);
  }
  return value.trim();
}
