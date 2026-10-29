from pathlib import Path

path = Path("CURRENT_STATUS.md")
text = path.read_text(encoding="utf-8")

anchor = "- CI workflow\n"
addition = (
    "- graceful shutdown is a first-class Runtime lifecycle: MissionSupervisor drain stops new wakes, clears queued triggers and lets only the currently admitted controller cycle reach its next durable cycle boundary before quiescing\n"
    "- provider-neutral DrainableHostAdapter wraps every production/custom HostAdapter, blocks new create/resume/capability admission during drain, tracks active native sessions plus create/resume admissions still in flight, and fail-closes duplicate active handle identities\n"
    "- Runtime shutdown uses one bounded grace phase for admitted supervisor work followed by one bounded forced phase; provider cancellation RPCs, supervisor settlement and Host idle share the same forced deadline rather than bypassing timeout policy\n"
    "- shutdown timeout never closes SQLite or disposes approval state while provider work is unsettled; durable Mission state remains readable for hard-exit/restart recovery, and a later retry can complete shutdown after the provider settles\n"
    "- Host sessions whose handles return after drain begins are automatically cancelled, while observed terminal sessions suppress duplicate cleanup cancellation and provider cancel requests are single-flight per active handle\n"
    "- startup recovery is coordinated with shutdown: recovery is single-flight, stops scheduling additional Missions after shutdown begins, and active recovery is awaited before Runtime resources can close\n"
    "- Mission API drain rejects new requests with 503, ends passive SSE subscribers with a runtime.shutdown event, and waits already-admitted HTTP handlers to leave their database boundary before Runtime shutdown closes SQLite\n"
    "- production SIGTERM/SIGINT handling stops HTTP admission and drains Runtime work with configurable grace/force/hard-exit deadlines; a second signal forces immediate process exit and hard-deadline failure preserves durable restart recovery semantics\n"
    "- shutdown integration coverage exercises supervisor no-rewake semantics, Host session/admission drain, HTTP request/SSE drain, forced cancellation, hanging cancel RPC timeout, late handle admission, duplicate-cancel suppression and SQLite reopen/recovery after forced or timed-out shutdown\n"
)
if text.count(anchor) != 1:
    raise SystemExit(f"expected one CI workflow anchor, got {text.count(anchor)}")
text = text.replace(anchor, addition + anchor)

old = (
    "1. graceful process shutdown / drain semantics for in-flight supervisor cycles and host sessions\n"
    "2. concrete provider-specific read-only Evidence bindings/adapters for deployed presentation render, browser/accessibility, media probe/playback, executable test/build and research-recency capabilities as hosts expose them; the Runtime Evidence framework and fail-closed gates are implemented, but unavailable host capabilities remain inconclusive\n"
    "3. extend provider-native capability graph coverage for model/reasoning options, subagents/team semantics and background/job execution as HostAdapters expose them\n"
    "4. external MCP discovery/acquisition plus provider-native MCP/Agent-Skill/CLI/general-code delivery with explicit trust, isolation, approval and rollback profiles, including Codex-native delivery instead of reusing DeepSeek/ACP semantics\n"
    "5. operational read-model/query APIs and observability for long-lived high-volume Missions, including dedicated side-effect query/projection paths beyond event-log reconstruction"
)
new = (
    "1. concrete provider-specific read-only Evidence bindings/adapters for deployed presentation render, browser/accessibility, media probe/playback, executable test/build and research-recency capabilities as hosts expose them; the Runtime Evidence framework and fail-closed gates are implemented, but unavailable host capabilities remain inconclusive\n"
    "2. extend provider-native capability graph coverage for model/reasoning options, subagents/team semantics and background/job execution as HostAdapters expose them\n"
    "3. external MCP discovery/acquisition plus provider-native MCP/Agent-Skill/CLI/general-code delivery with explicit trust, isolation, approval and rollback profiles, including Codex-native delivery instead of reusing DeepSeek/ACP semantics\n"
    "4. operational read-model/query APIs and observability for long-lived high-volume Missions, including dedicated side-effect query/projection paths beyond event-log reconstruction"
)
if text.count(old) != 1:
    raise SystemExit(f"expected one agent07 frontier block, got {text.count(old)}")
path.write_text(text.replace(old, new), encoding="utf-8")
