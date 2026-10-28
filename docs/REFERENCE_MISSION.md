# Reference Mission

## Mission contract

The standing integration stress test is:

> Produce a 45-minute high-production AI technology keynote with an editable presentation, speaker notes, supporting motion/media, and source record. The result should feel like a technical launch keynote rather than a conventional corporate deck and should use current reliable information.

The Reference Mission is not a special product path. It is a pressure test for the general Mission Runtime. Production code must not branch on `tech-keynote`, test mission ids, fixture names, or Reference-specific artifact contents.

## What the suite must prove

A passing Reference Mission is stronger than a collection of green unit tests. It must demonstrate that the same durable controller can:

- recover or fail closed after process/provider-session loss;
- convert ambiguous execution outcomes into explicit blocking gaps rather than optimistic completion;
- keep external side effects idempotent across repair/recovery;
- turn capability acquisition failure into a replannable capability gap;
- retire obsolete blocked/failed Work only through explicit, auditable replacement semantics;
- preserve user steering durably across restart and apply it before stale ready Work can execute;
- require independent, registered Runtime Evidence for artifact-quality decisions;
- repair a verified defect, create a new artifact version, and keep the defective version non-final;
- close gaps only from explicit independent-verifier resolution evidence;
- complete only after deterministic completion gates and the independent completion challenge pass.

## Automated fault matrix

| Fault | Required Runtime behavior | Automated proof |
| --- | --- | --- |
| Process dies with an active execution | Reconstruct durable execution binding on a fresh process and attempt exact-route recovery before replanning | `tests/e2e/reference-mission-fault-injection.test.ts` |
| Provider/native session is gone after restart | Mark execution lost, fail the attempt/Work, open a blocking runtime gap, diagnose and create replacement Work | `tests/e2e/reference-mission-fault-injection.test.ts` |
| Independent verifier crashes on the first repair | Persist inconclusive verification/runtime gap and require another diagnosis/repair cycle instead of trusting producer completion | `tests/e2e/reference-mission-fault-injection.test.ts` |
| Required external capability cannot be safely acquired | Keep dependent Work blocked, persist a capability gap, replan to a safe fallback and do not repeatedly ensure the failed need | `tests/e2e/reference-mission-capability-fault.test.ts` |
| Replacement Work supersedes obsolete blocked/failed Work | Use explicit `supersedesWorkItemRefs`; persist the old Work transition to `superseded`; recover a half-finished supersession after restart | `tests/e2e/reference-mission-capability-fault.test.ts`, `tests/integration/work-supersession-recovery.test.ts` |
| Planner tries unsafe replacement semantics | Reject unknown targets, self-supersession and attempts to erase already-succeeded Work | `tests/integration/work-supersession-admission.test.ts` |
| Driver claims success while an irreversible side effect is still `unknown` | Normalize the execution to `partial`, preserve the original receipt, skip artifact verification, open a blocking runtime gap and repair without replaying the action | `tests/e2e/reference-mission-side-effect-ambiguity.test.ts` |
| User changes technical/style direction after stale Work is already ready, then Runtime restarts | Rebuild steering from durable events; invalidate stale ready Work before marking steering applied; revise strategy; create replacement frontier; never execute stale Work | `tests/e2e/reference-mission-steering-restart.test.ts`, `tests/integration/steering-read-model-recovery.test.ts` |
| Presentation exists but rendered layout is materially broken | Registered `presentation-render` Evidence grounds a verifier failure; defective artifact remains invalid; targeted repair produces a new version; clean render Evidence is required before final promotion | `tests/e2e/reference-mission-render-defect.test.ts` |

## Production invariants discovered by fault injection

The Reference suite has already exposed production gaps that isolated happy-path tests did not reveal:

1. **Obsolete blocked Work can deadlock completion.** Replacement Work now carries explicit `supersedesWorkItemRefs`. The controller validates the relation, persists `work.updated -> superseded`, and reconciles an interrupted supersession on any later cycle.
2. **A successful driver status is not enough when side-effect completion is ambiguous.** If any returned side-effect receipt is not explicitly `succeeded`, a claimed successful execution is normalized to `partial` and cannot enter artifact verification/final promotion.
3. **User steering was previously only an event-log decoration.** Steering now has its own rebuildable SQLite projection, is present in the durable Mission journal/planner context, carries a strategy-applied sequence checkpoint, invalidates stale unstarted Work before strategy revision, and is recovered after process restart.
4. **Artifact existence is not deliverable quality.** Render Evidence can ground a material presentation defect and force versioned repair before final promotion.

These are general Runtime invariants, not Reference Mission exceptions.

## Steering crash-safety contract

For steering that arrives while Work is ready but has not started, the safe ordering is:

1. persist `user.steering.received`;
2. on the next controller cycle, detect steering sequence newer than `strategyAppliedSteeringSequence`;
3. durably invalidate stale **ready** Work;
4. compose/revise strategy with the full durable steering history and current strategy;
5. persist the strategy revision with `appliedSteeringSequence`;
6. plan a new frontier and, when appropriate, explicitly supersede the obsolete Work;
7. only then dispatch replacement Work.

If the process dies after step 3 but before step 5, the steering remains unapplied and the next process repeats strategy composition. The Runtime does not blindly cancel already-running Work because cancellation/replay can have side-effect consequences; running Work remains subject to recovery, verification and the completion challenge.

## Evidence truth boundary

The suite may use deterministic fixture collectors to inject a known observation, but the production verifier contract is unchanged:

- a verifier may cite only Runtime-registered Evidence ids;
- static/package inspection cannot masquerade as browser, native render, media playback/probe, executable-test/build or source-recency evidence;
- unsupported positive **or negative** judgments become inconclusive;
- gap resolution requires cited supporting Runtime Evidence;
- provider-specific evidence remains unavailable until the host exposes a real capability and Runtime explicitly binds it through the trusted read-only Evidence adapter.

## Remaining Reference Mission fault scenes

Two original keynote-specific scenes remain dependent on concrete provider/deployment Evidence capabilities and are intentionally not fabricated by tests that would imply production support:

- **stale key research source** — once a real `source-recency` capability is bound, the Reference suite should inject an expired/replaced source, require an evidence/research gap, refresh the source record, and re-verify affected claims;
- **media integration/playback failure** — once real `media-probe` / `media-playback` capabilities are bound, the suite should inject a missing/corrupt media reference, require integration repair, and prove the final presentation/media package plays through successfully.

Until those host capabilities exist, the corresponding verifier-profile checks correctly remain inconclusive rather than being faked by file-name or producer claims.

## Exit condition for this Reference stage

This stage is considered green only when all automated scenes above pass together on the normal CI path, the branch remains compatible with the production bootstrap, and no Reference-specific production code exists. Future provider-specific source-recency and media-playback scenes extend this same matrix rather than replacing it.
