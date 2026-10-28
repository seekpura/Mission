# DeepSeek Harness ACP Binding — Implementation Note

## Decision

The first production DeepSeek Harness binding will use the official Agent Client Protocol TypeScript SDK rather than a hand-written JSON-RPC implementation.

- Protocol: stable ACP v1
- SDK: `@agentclientprotocol/sdk@1.4.0`
- DSH launch surface: `dsh --profile acp`
- Transport: newline-delimited JSON over child-process stdio
- Core dependency rule: Mission core does not import DSH internals; only the host adapter package depends on ACP transport details.

The initial SDK pin matches the version currently declared by DeepSeek Harness's `@deepseek-ai/dsh-acp` package. Protocol upgrades are isolated behind the DeepSeek host binding.

## Lifecycle

A Mission worker agent maps to one DSH ACP child/session lifecycle in the first implementation:

1. validate an absolute executable workspace directory;
2. spawn the resolved `dsh` binary with `--profile acp`;
3. create `ndJsonStream` over stdin/stdout;
4. call ACP `initialize` with Mission as the client;
5. create a new ACP session for the work item workspace;
6. send Mission's compiled context as the first prompt;
7. translate `session/update` notifications to `HostAgentEvent`;
8. answer `session/request_permission` through Mission's approval callback, selecting only an advertised one-shot option;
9. record the native session id on the HostAgentHandle;
10. on completion/failure, close transport and reap the child;
11. on cancellation, request protocol cancellation when possible and terminate the child if necessary.

Resume/reconnect will be layered on after the first create/observe/cancel round trip is proven by tests.

## Security boundary

The binding does not grant DSH permissions up front and does not bypass DSH sandbox/approval policy. A DSH permission request is surfaced to Mission; Mission may approve or reject the individual request according to mission policy and user approval state. DSH remains authoritative for actions it has already denied or restricted.

## Test strategy

Normal CI will use a fake ACP agent child process so protocol translation is testable without local DSH credentials or installation.

A separate opt-in live smoke test may run when a `dsh` binary is present. It is not required for the ordinary test suite.
