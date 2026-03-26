# pi-subagents

Codex-style multi-agent orchestration for [pi](https://github.com/badlogic/pi-mono). Spawn, communicate with, and coordinate sub-agents via LLM tool calls.

Sub-agents are invisible child `pi --mode rpc` processes. No terminal multiplexer required, no TUI overlay. The LLM orchestrates everything through 5 tools.

https://github.com/user-attachments/assets/00fcf919-a981-4695-bb80-5282c1cfb9be

## Install

```bash
pi install npm:pi-agents-pool
```

Or from git:

```bash
pi install git:github.com/minghinmatthewlam/pi-subagents
```

## Tools

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a sub-agent with a task. Returns immediately with an agent ID; the agent runs in the background and notifies the main session when done. |
| `send_input` | Send a follow-up message to an existing agent. Supports `interrupt` to redirect work. |
| `wait_agent` | Block until one or more agents finish. Use only when the main session is blocked on the result right now. |
| `close_agent` | Shut down an agent. Can be resumed later. |
| `resume_agent` | Resume a previously closed agent from its saved session. |

## How It Works

Recommended flow:

```
1. LLM calls spawn_agent("Analyze the auth module")  -> returns agent ID immediately
2. LLM calls spawn_agent("Analyze the DB module")    -> returns another agent ID
3. LLM keeps doing local non-overlapping work
4. Finished agents steer results back automatically via <subagent_notification>
5. LLM reads results, integrates, continues
```

`wait_agent` is the exception path, not the default path. Use it only when the main session is blocked on a result and must pause.

When an agent finishes, the extension injects a `<subagent_notification>...</subagent_notification>` message and triggers a new turn automatically. That notification is an agent result, not a user message.

Each agent is a persistent `pi --mode rpc` child process with full bidirectional communication. The LLM can send follow-up messages, interrupt ongoing work, and reuse agents for related questions.

A widget above the input shows live progress:

```
2 agents (2 running)
├─ Analyze the auth module (explorer) · 3 tool uses · 12.4k tokens · 0:23
│  └ Read: src/auth/index.ts
├─ Analyze the DB module (explorer) · 1 tool use · 4.1k tokens · 0:15
│  └ thinking…
```

## Agent Types

Agent types are purely advisory — they guide the LLM on when and how to use each role. There is no mechanical difference between types.

| Type | Guidance |
|------|----------|
| `explorer` | Fast codebase questions. Spawn multiple in parallel for independent questions. Trust results. Reuse via `send_input`. |
| `worker` | Implementation tasks. Assign explicit file ownership. Tell workers they are not alone in the codebase. |

```
spawn_agent({ message: "What does the auth module do?", agent_type: "explorer" })
spawn_agent({ message: "Implement the login endpoint", agent_type: "worker" })
```

## Depth Limiting

Sub-agents can themselves spawn further sub-agents, limited by depth:

- `PI_SUBAGENT_MAX_DEPTH` (default: 2) — maximum nesting depth
- Main session (depth 0) can spawn agents (depth 1), which can spawn sub-agents (depth 2), which cannot spawn further

Override:

```bash
export PI_SUBAGENT_MAX_DEPTH=3   # allow deeper nesting
export PI_SUBAGENT_MAX_DEPTH=1   # only one level of agents
```

## Parameters

### spawn_agent

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | Task prompt for the agent |
| `agent_type` | string | no | Role hint: "explorer" or "worker" |
| `model` | string | no | Override model (e.g. "anthropic/claude-haiku-4-5") |

### send_input

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Agent ID from spawn_agent |
| `message` | string | yes | Message to send |
| `interrupt` | boolean | no | Abort current work before sending |

### wait_agent

Use only when you are blocked on a dependency and need to pause the main session until an agent finishes. On timeout, the agents keep running in the background.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string[] | yes | Agent IDs to wait for |
| `timeout_ms` | number | no | Timeout (default: 30s, min: 10s, max: 1h) |

### close_agent / resume_agent

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Agent ID |

## License

MIT
