# pi-subagents

Codex-style multi-agent orchestration for [pi](https://github.com/badlogic/pi-mono). Spawn, communicate with, and coordinate sub-agents via LLM tool calls.

Sub-agents are invisible child `pi --mode rpc` processes. No terminal multiplexer required, no TUI overlay. The LLM orchestrates everything through 5 tools.

## Install

```bash
pi install git:github.com/minghinmatthewlam/pi-subagents
```

## Tools

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a sub-agent with a task. Returns immediately with an agent ID. |
| `send_input` | Send a follow-up message to an existing agent. Supports `interrupt` to redirect work. |
| `wait_agent` | Wait for one or more agents to finish. Returns statuses and last responses. |
| `close_agent` | Shut down an agent. Can be resumed later. |
| `resume_agent` | Resume a previously closed agent from its saved session. |

## How It Works

```
1. LLM calls spawn_agent("Analyze the auth module")  -> returns agent ID immediately
2. LLM calls spawn_agent("Analyze the DB module")    -> returns another agent ID
3. LLM does local work while agents run in background
4. LLM calls wait_agent([id1, id2])                  -> blocks until one finishes
5. LLM reads results, integrates, continues
```

Each agent is a persistent `pi --mode rpc` child process with full bidirectional communication. The LLM can send follow-up messages, interrupt ongoing work, and reuse agents for related questions.

A widget above the input shows live progress:

```
2 agents (2 running)
├─ Analyze the auth module (explorer) · 3 tool uses · 12.4k tokens · 0:23
│  └ Read: src/auth/index.ts
├─ Analyze the DB module (explorer) · 1 tool use · 4.1k tokens · 0:15
│  └ Initializing…
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
| `fork_context` | boolean | no | Fork current session into the agent for full context |

### send_input

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Agent ID from spawn_agent |
| `message` | string | yes | Message to send |
| `interrupt` | boolean | no | Abort current work before sending |

### wait_agent

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
