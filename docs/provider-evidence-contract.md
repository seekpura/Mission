# Structured Provider Evidence Contract

Mission Runtime can consume provider-native verification evidence only when the live `HostAdapter` explicitly exposes a compatible read-only host capability. Configuration never creates or upgrades a host capability.

## Protocol

Production structured routes use protocol `mission-evidence/v1` and are configured through `MISSION_EVIDENCE_PROVIDER_ROUTES_JSON`.

Each route pins:

- a stable Runtime route id;
- the exact live capability id;
- the exact `capability.native.provider` identity;
- protocol `mission-evidence/v1`;
- optionally the exact provider-native capability id;
- one Runtime-supported Evidence kind;
- `readOnly: true`;
- the exact permission allowlist and optional metering/cost/output bounds.

The Evidence kind selects a Runtime-owned contract. Deployment configuration cannot redefine the semantic function, verification profile, supported Artifact type, durable Evidence type or durable claim.

Supported production kinds are:

| Evidence kind | Required semantic function | Profile / Artifact |
| --- | --- | --- |
| `presentation-render` | `verification.presentation.render` | presentation |
| `browser-runtime` | `verification.browser.inspect` | website |
| `accessibility-check` | `verification.accessibility.audit` | website |
| `media-probe` | `verification.media.probe` | video/audio |
| `media-playback` | `verification.media.playback` | video/audio |
| `executable-test` | `verification.code.test` | code |
| `build-check` | `verification.code.build` | code |
| `integration-test` | `verification.code.integration-test` | code |
| `source-recency` | `verification.research.recency` | research |

A live capability must be available, host-native, host-scoped, routed as `host-capability`, advertise the exact semantic function and `verification-evidence` output, and match the trusted provider/protocol/native identity. Permission, metering and monetary-class checks run before invocation.

## Request envelope

Runtime calls the exact configured host capability with a bounded request containing:

```json
{
  "operation": "mission.verification.collect_evidence",
  "contract": "mission-evidence/v1",
  "routeId": "browser-provider",
  "evidenceKind": "browser-runtime",
  "missionId": "mission-123",
  "subject": {
    "artifactId": "site",
    "contentHash": "sha256:..."
  },
  "artifact": {
    "id": "site",
    "version": 1,
    "logicalName": "site",
    "type": "website",
    "uri": "/workspace/index.html",
    "contentHash": "sha256:..."
  },
  "verificationProfile": {
    "id": "website-mission-review-v1",
    "kind": "website"
  }
}
```

## Response envelope

The provider response must be JSON-serializable, stay inside the configured output budget and bind itself back to the exact requested Artifact identity:

```json
{
  "schemaVersion": "mission-evidence/v1",
  "evidenceKind": "browser-runtime",
  "subject": {
    "artifactId": "site",
    "contentHash": "sha256:..."
  },
  "result": "supports",
  "observedAt": "2026-10-29T00:10:00.000Z",
  "summary": "Root route loaded and primary navigation responded.",
  "observation": {
    "loaded": true,
    "blockingErrorCount": 0,
    "interactions": ["primary-navigation"]
  }
}
```

`result` is limited to `supports`, `contradicts` or `inconclusive`. Provider-supplied durable claims, source references or provenance are ignored; Runtime creates those fields from the trusted route and live capability descriptor.

## Kind-specific observation schemas

Non-inconclusive responses require an observation. Runtime validates the minimum semantic shape and rejects verdict/observation contradictions.

- `presentation-render`: positive `renderedUnits`, non-negative `renderFailureCount`; `supports` requires zero render failures.
- `browser-runtime`: boolean `loaded`, non-negative `blockingErrorCount`, optional bounded `interactions[]`; `supports` requires loaded with zero blocking errors.
- `accessibility-check`: non-negative `checkedNodeCount`, `violationCount`, `blockingViolationCount`; blocking violations cannot exceed total violations and `supports` requires zero blocking violations.
- `media-probe`: positive finite `durationMs` and positive integer `streamCount`.
- `media-playback`: boolean `playedToEnd` and non-negative `playbackErrorCount`; `supports` requires full playback with zero playback errors.
- `executable-test`, `build-check`, `integration-test`: boolean `passed` and integer `exitCode`; `supports` requires `passed=true` and `exitCode=0`, while `contradicts` cannot claim the same successful state.
- `source-recency`: positive `checkedSourceCount`, non-negative `freshSourceCount` and `staleSourceCount`, plus valid timestamp `asOf`; counts must be internally consistent and `supports` requires zero stale sources.

Validated observation details remain transient verifier inspection material. They do not become an unbounded durable audit payload.

## Missing capability behavior

A route is only a trust/configuration binding. If the live HostAdapter does not expose the configured capability, or exposes it with incompatible provider/protocol/permissions/cost/semantics, the collector reports that Evidence kind unavailable. No Evidence is fabricated and profile checks requiring that Evidence remain inconclusive.

The current DeepSeek ACP and Codex app-server adapters do not expose arbitrary `invokeHostCapability` execution. They therefore do not gain browser/render/media/test/recency Evidence merely by setting `MISSION_EVIDENCE_PROVIDER_ROUTES_JSON`. A provider/native adapter must first expose a truthful compatible read-only capability.

## Example route

```json
[
  {
    "id": "browser-provider",
    "capabilityId": "browser.runtime.prod",
    "provider": "browser-provider",
    "protocol": "mission-evidence/v1",
    "nativeId": "browser-runtime-v3",
    "evidenceKind": "browser-runtime",
    "readOnly": true,
    "allowedPermissions": ["browser-read"],
    "allowMetered": false,
    "maxMonetaryClass": "low",
    "maxOutputBytes": 65536
  }
]
```

The older `MISSION_HOST_EVIDENCE_BINDINGS_JSON` remains available as a lower-level trusted custom integration surface. Prefer the structured provider route when deploying production provider-native verification because its semantic mapping and output contract are Runtime-owned.
