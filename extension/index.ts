/**
 * pi-subagents: Codex-style multi-agent orchestration for pi.
 *
 * Provides 5 tools: spawn_agent, send_input, wait_agent, close_agent, resume_agent.
 * Sub-agents are invisible child pi --mode rpc processes.
 * The LLM orchestrates everything — no TUI overlay, no terminal multiplexer.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentPool } from "./agent-pool.ts";
import {
  type AgentStatus,
  type SpawnAgentDetails,
  type SendInputDetails,
  type WaitAgentDetails,
  type CloseAgentDetails,
  type ResumeAgentDetails,
  getCurrentDepth,
  getMaxDepth,
  MIN_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
} from "./types.ts";

// ============================================================================
// Widget rendering
// ============================================================================

const ACCENT = "\x1b[38;2;77;163;255m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";

function formatElapsed(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

function renderAgentWidget(pool: AgentPool): string[] | undefined {
  const agents = pool.getAgents();
  if (agents.size === 0) return undefined;

  const running = [...agents.values()].filter(
    (a) => a.status === "starting" || a.status === "streaming",
  );
  const idle = [...agents.values()].filter((a) => a.status === "idle");
  const total = agents.size;

  const parts: string[] = [];
  if (running.length > 0) parts.push(`${running.length} running`);
  if (idle.length > 0) parts.push(`${idle.length} idle`);

  const lines: string[] = [];
  lines.push(`${DIM}${total} agent${total !== 1 ? "s" : ""}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}${RST}`);

  const entries = [...agents.values()];
  for (let i = 0; i < entries.length; i++) {
    const agent = entries[i];
    const isLast = i === entries.length - 1;
    const branch = isLast ? "└─" : "├─";
    const continuation = isLast ? "   " : "│  ";

    const typeTag = agent.agentType ? ` (${agent.agentType})` : "";
    const toolInfo = `${agent.toolCount} tool use${agent.toolCount !== 1 ? "s" : ""}`;
    const tokenInfo = agent.tokenCount > 0 ? ` · ${formatTokens(agent.tokenCount)} tokens` : "";
    const elapsed = formatElapsed(agent.startTime);

    const statusIcon =
      agent.status === "idle"
        ? "✓"
        : agent.status === "crashed"
          ? "✗"
          : "";

    lines.push(
      `${DIM}${branch}${RST} ${agent.taskPreview}${DIM}${typeTag}${RST} · ${toolInfo}${tokenInfo} · ${elapsed}${statusIcon ? ` ${statusIcon}` : ""}`,
    );

    // Activity sub-line
    const activity =
      agent.currentActivity ??
      (agent.status === "starting"
        ? "Initializing…"
        : agent.status === "idle"
          ? "done"
          : agent.status === "crashed"
            ? agent.error ?? "crashed"
            : undefined);

    if (activity) {
      lines.push(`${DIM}${continuation}└ ${activity}${RST}`);
    }
  }

  return lines;
}

// ============================================================================
// Tool descriptions
// ============================================================================

const SPAWN_AGENT_DESCRIPTION = `Spawn a sub-agent for a well-scoped task. Returns the agent ID immediately — the agent runs in the background. When the agent finishes, its result is automatically delivered back to you as a notification. You can also use wait_agent to explicitly block, or send_input to send follow-ups.

### When to delegate vs. do locally
- Plan first: identify critical-path blockers vs. sidecar tasks that can run in parallel.
- Delegate bounded sidecar tasks that run in parallel with your local work. Prefer tasks that materially advance the goal without blocking your immediate next step.
- Do NOT delegate urgent blocking work when your very next action depends on the result.
- Keep tightly-coupled or difficult work local.

### Designing delegated tasks
- Tasks must be concrete, well-defined, and self-contained.
- For coding tasks: assign disjoint file ownership per worker to avoid conflicts.
- Narrow the ask to the concrete output you need.

### After delegating
- Continue doing meaningful non-overlapping work while agents run in the background.
- Agent results will be delivered to you automatically when they finish — you do not need to call wait_agent for every agent.
- Only call wait_agent when you need the result immediately for your next step and are blocked until it arrives.
- Do not redo delegated work — integrate results when they arrive.
- Reuse existing agents via send_input for follow-up questions.

### Parallel patterns
- Spawn multiple explorers in parallel for independent codebase questions.
- Split implementation into disjoint file sets and spawn workers in parallel.`;

const SEND_INPUT_DESCRIPTION =
  "Send a message to an existing agent. Use interrupt=true to redirect work immediately. " +
  "Reuse agents for related follow-up questions instead of spawning new ones.";

const WAIT_AGENT_DESCRIPTION =
  "Wait until at least one of the specified agents finishes its current turn. " +
  "Returns statuses and last response text for all requested agents. " +
  "Call sparingly — only when you need the result for your next step and are blocked.";

const CLOSE_AGENT_DESCRIPTION =
  "Shut down an agent. Closed agents can be resumed later with resume_agent.";

const RESUME_AGENT_DESCRIPTION =
  "Resume a previously closed agent from its saved session. " +
  "The agent retains its full conversation history.";

// ============================================================================
// Extension entry
// ============================================================================

export default function piSubagents(pi: ExtensionAPI): void {
  const pool = new AgentPool();
  let latestCtx: ExtensionContext | null = null;
  let widgetInterval: ReturnType<typeof setInterval> | null = null;

  const depth = getCurrentDepth();
  const maxDepth = getMaxDepth();
  const canSpawn = depth < maxDepth;

  // -- Lifecycle --

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    pool.setParentSession(sessionId, sessionFile);
  });

  pi.on("session_shutdown", () => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    pool.cleanup();
  });

  // -- Widget updates --

  function updateWidget(): void {
    if (!latestCtx?.hasUI) return;
    const lines = renderAgentWidget(pool);
    if (lines) {
      latestCtx.ui.setWidget("subagent-status", lines, { placement: "aboveEditor" });
    } else {
      latestCtx.ui.setWidget("subagent-status", undefined);
      if (widgetInterval) {
        clearInterval(widgetInterval);
        widgetInterval = null;
      }
    }
  }

  function ensureWidgetRefresh(): void {
    if (widgetInterval) return;
    updateWidget();
    widgetInterval = setInterval(updateWidget, 1_000);
  }

  pool.setOnAgentUpdate(() => {
    updateWidget();
  });

  // -- Auto-notification on agent completion (steer back to main session) --

  pool.setOnAgentComplete((agentId, agent) => {
    const elapsed = Math.floor((Date.now() - agent.startTime) / 1000);
    const typeTag = agent.agentType ? ` (${agent.agentType})` : "";
    const response = agent.lastOutput
      ? agent.lastOutput.length > 2000
        ? agent.lastOutput.slice(0, 2000) + "…"
        : agent.lastOutput
      : "(no response)";
    const content =
      `Sub-agent ${agentId}${typeTag} completed (${elapsed}s).\n\n${response}`;

    pi.sendMessage(
      {
        customType: "subagent_complete",
        content,
        display: true,
        details: {
          agent_id: agentId,
          agent_type: agent.agentType,
          status: agent.status,
          elapsed,
          task: agent.taskPreview,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  });

  // -- Tools --

  if (!canSpawn) return; // at max depth, don't register any tools

  // ---- spawn_agent ----

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: SPAWN_AGENT_DESCRIPTION,
    parameters: Type.Object({
      message: Type.String({
        description: "Task prompt for the new agent. Be specific and self-contained.",
      }),
      agent_type: Type.Optional(
        Type.String({
          description:
            "Optional role hint. " +
            '"explorer": fast codebase questions — spawn multiple in parallel for independent questions, trust results, reuse via send_input. ' +
            '"worker": implementation tasks — assign explicit file ownership, tell workers they are not alone in the codebase.',
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Override model for this agent (e.g. anthropic/claude-haiku-4-5)." }),
      ),
      fork_context: Type.Optional(
        Type.Boolean({
          description:
            "Fork the current session into the new agent so it starts with your full conversation context.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await pool.spawnAgent({
        message: params.message,
        agentType: params.agent_type,
        model: params.model,
        forkContext: params.fork_context,
      });
      ensureWidgetRefresh();
      return {
        content: [{ type: "text", text: `Agent ${result.agent_id} started.` }],
        details: {
          agent_id: result.agent_id,
          agent_type: params.agent_type,
          session_file: result.session_file,
        } satisfies SpawnAgentDetails,
      };
    },

    renderCall(args, theme) {
      const type = args.agent_type ? theme.fg("dim", ` (${args.agent_type})`) : "";
      const task = args.message
        ? "\n" + theme.fg("dim", (args.message.split("\n").find((l: string) => l.trim()) || "").slice(0, 100))
        : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_agent")) + type + task,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as SpawnAgentDetails | undefined;
      if (!d) return new Text(theme.fg("dim", "started"), 0, 0);
      const type = d.agent_type ? theme.fg("dim", ` (${d.agent_type})`) : "";
      return new Text(
        theme.fg("success", "✓") +
          " " +
          theme.fg("accent", d.agent_id) +
          type +
          theme.fg("dim", " started"),
        0,
        0,
      );
    },
  });

  // ---- send_input ----

  pi.registerTool({
    name: "send_input",
    label: "Send Input",
    description: SEND_INPUT_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: "Agent ID (from spawn_agent)." }),
      message: Type.String({ description: "Message to send to the agent." }),
      interrupt: Type.Optional(
        Type.Boolean({ description: "If true, abort the agent's current work before sending." }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await pool.sendInput(params.id, params.message, params.interrupt);
      return {
        content: [{ type: "text", text: `Sent to agent ${params.id}.` }],
        details: { agent_id: params.id, status: result.status } satisfies SendInputDetails,
      };
    },

    renderCall(args, theme) {
      const target = args.id ? theme.fg("accent", args.id) : "?";
      const interrupt = args.interrupt ? theme.fg("warning", " [interrupt]") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("send_input")) + " → " + target + interrupt,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as SendInputDetails | undefined;
      return new Text(
        theme.fg("success", "✓") + " Sent to " + theme.fg("accent", d?.agent_id ?? "?"),
        0,
        0,
      );
    },
  });

  // ---- wait_agent ----

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description: WAIT_AGENT_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: "Agent IDs to wait for. Resolves when at least one finishes.",
      }),
      timeout_ms: Type.Optional(
        Type.Number({
          description: `Timeout in milliseconds (default: ${DEFAULT_WAIT_TIMEOUT_MS}, min: ${MIN_WAIT_TIMEOUT_MS}, max: ${MAX_WAIT_TIMEOUT_MS}).`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const result = await pool.waitForAgents({
        ids: params.ids,
        timeoutMs: params.timeout_ms,
        signal: signal ?? undefined,
      });

      // Build human-readable summary
      const lines: string[] = [];
      if (result.timed_out) lines.push("Timed out waiting.");
      for (const [id, entry] of Object.entries(result.statuses)) {
        const status = entry.status;
        const preview = entry.last_response
          ? entry.last_response.length > 500
            ? entry.last_response.slice(0, 500) + "…"
            : entry.last_response
          : "(no response)";
        lines.push(`[${id}] ${status}:\n${preview}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: result satisfies WaitAgentDetails,
      };
    },

    renderCall(args, theme) {
      const ids = (args.ids || []).map((id: string) => theme.fg("accent", id)).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("wait_agent")) + " " + ids,
        0,
        0,
      );
    },

    renderResult(result, opts, theme) {
      const d = result.details as WaitAgentDetails | undefined;
      if (!d) return new Text(theme.fg("dim", "waiting…"), 0, 0);

      const entries = Object.entries(d.statuses);
      const finished = entries.filter(([, e]) => e.status === "idle" || e.status === "closed");
      const timedOut = d.timed_out ? theme.fg("warning", " (timed out)") : "";

      if (!opts.expanded) {
        // Collapsed: one-line summary
        return new Text(
          theme.fg("success", "✓") +
            ` ${finished.length}/${entries.length} agents finished` +
            timedOut,
          0,
          0,
        );
      }

      // Expanded: show each agent's response
      const lines: string[] = [];
      for (const [id, entry] of entries) {
        const icon = entry.status === "idle" ? theme.fg("success", "✓") : theme.fg("dim", "○");
        const response = entry.last_response
          ? "\n" + theme.fg("dim", entry.last_response.slice(0, 300))
          : "";
        lines.push(`${icon} ${theme.fg("accent", id)} ${theme.fg("dim", entry.status)}${response}`);
      }
      if (d.timed_out) lines.push(theme.fg("warning", "Timed out"));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ---- close_agent ----

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description: CLOSE_AGENT_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: "Agent ID to close." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await pool.closeAgent(params.id);
      return {
        content: [
          { type: "text", text: `Agent ${params.id} closed (was ${result.previous_status}).` },
        ],
        details: {
          agent_id: params.id,
          previous_status: result.previous_status,
        } satisfies CloseAgentDetails,
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("close_agent")) +
          " " +
          theme.fg("accent", args.id || "?"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as CloseAgentDetails | undefined;
      return new Text(
        theme.fg("success", "✓") +
          " " +
          theme.fg("accent", d?.agent_id ?? "?") +
          theme.fg("dim", ` closed (was ${d?.previous_status ?? "?"})`),
        0,
        0,
      );
    },
  });

  // ---- resume_agent ----

  pi.registerTool({
    name: "resume_agent",
    label: "Resume Agent",
    description: RESUME_AGENT_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: "Agent ID to resume (must have been previously closed)." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await pool.resumeAgent(params.id);
      ensureWidgetRefresh();
      return {
        content: [{ type: "text", text: `Agent ${params.id} resumed.` }],
        details: {
          agent_id: result.agent_id,
          status: "idle" as AgentStatus,
          session_file: result.session_file,
        } satisfies ResumeAgentDetails,
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("resume_agent")) +
          " " +
          theme.fg("accent", args.id || "?"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as ResumeAgentDetails | undefined;
      return new Text(
        theme.fg("success", "✓") +
          " " +
          theme.fg("accent", d?.agent_id ?? "?") +
          theme.fg("dim", " resumed"),
        0,
        0,
      );
    },
  });
}
