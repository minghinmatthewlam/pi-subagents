/**
 * Agent pool: manages child pi --mode rpc processes as sub-agents.
 *
 * Each agent is a persistent pi process with bidirectional JSON-line communication.
 * The pool handles spawning, message routing, status tracking, and cleanup.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  type AgentStatus,
  type ManagedAgent,
  type RpcResponse,
  type WaitAgentEntry,
  isFinalStatus,
  getCurrentDepth,
  getMaxDepth,
  DEFAULT_MAX_AGENTS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MIN_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
} from "./types.ts";

// ============================================================================
// Minimal RPC layer
// ============================================================================

function writeRpcCommand(proc: ChildProcess, command: Record<string, unknown>): boolean {
  if (!proc.stdin || !proc.stdin.writable) return false;
  try {
    proc.stdin.write(JSON.stringify(command) + "\n");
    return true;
  } catch {
    return false;
  }
}

function sendRpcRequest(
  agent: ManagedAgent,
  command: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<RpcResponse> {
  const id = `req_${++agent.requestCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.pendingRequests.delete(id);
      reject(new Error(`RPC timeout for ${command.type}`));
    }, timeoutMs);

    agent.pendingRequests.set(id, {
      resolve: (response: RpcResponse) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    if (!writeRpcCommand(agent.process, { ...command, id })) {
      clearTimeout(timer);
      agent.pendingRequests.delete(id);
      reject(new Error("Failed to write to agent stdin"));
    }
  });
}

/**
 * Attach a JSON-line reader to a readable stream.
 * Returns a detach function.
 */
function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  let buffer = "";
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  };
  stream.on("data", onData);
  return () => {
    stream.removeListener("data", onData);
  };
}

// ============================================================================
// Agent Pool
// ============================================================================

export interface SpawnOptions {
  message: string;
  agentType?: string;
  model?: string;
  forkContext?: boolean;
}

export interface WaitOptions {
  ids: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WaitResult {
  statuses: Record<string, WaitAgentEntry>;
  timed_out: boolean;
}

export type AgentEventCallback = (agentId: string, agent: ManagedAgent) => void;

/** Called when an agent completes (reaches idle). */
export type AgentCompleteCallback = (agentId: string, agent: ManagedAgent) => void;

export class AgentPool {
  private agents = new Map<string, ManagedAgent>();
  private closedSessions = new Map<string, string>(); // agent ID -> session file
  private parentSessionId: string = `session-${Date.now()}`;
  private parentSessionFile: string | null = null;
  private onAgentUpdate: AgentEventCallback | null = null;
  private onAgentComplete: AgentCompleteCallback | null = null;
  private maxAgents: number = DEFAULT_MAX_AGENTS;

  setParentSession(sessionId: string, sessionFile: string | null): void {
    this.parentSessionId = sessionId;
    this.parentSessionFile = sessionFile;
  }

  setOnAgentUpdate(cb: AgentEventCallback | null): void {
    this.onAgentUpdate = cb;
  }

  setOnAgentComplete(cb: AgentCompleteCallback | null): void {
    this.onAgentComplete = cb;
  }

  getAgents(): Map<string, ManagedAgent> {
    return this.agents;
  }

  getAgent(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  // --------------------------------------------------------------------------
  // spawn
  // --------------------------------------------------------------------------

  async spawnAgent(options: SpawnOptions): Promise<{ agent_id: string; session_file: string }> {
    const currentDepth = getCurrentDepth();
    const maxDepth = getMaxDepth();
    if (currentDepth >= maxDepth) {
      throw new Error(
        `Agent depth limit reached (${currentDepth}/${maxDepth}). Solve the task yourself.`,
      );
    }

    const activeCount = [...this.agents.values()].filter(
      (a) => a.status === "starting" || a.status === "streaming" || a.status === "idle",
    ).length;
    if (activeCount >= this.maxAgents) {
      throw new Error(
        `Agent limit reached (${activeCount}/${this.maxAgents}). Close existing agents before spawning new ones.`,
      );
    }

    const id = randomBytes(4).toString("hex");
    const sessionDir = join(tmpdir(), "pi-subagents", this.parentSessionId);
    const sessionFile = join(sessionDir, `${id}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });

    const args = ["--mode", "rpc", "--session", sessionFile];
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.forkContext && this.parentSessionFile) {
      args.push("--fork", this.parentSessionFile);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PI_SUBAGENT_DEPTH: String(currentDepth + 1),
    };

    const proc = spawn("pi", args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const taskPreview = options.message.split("\n").find((l) => l.trim())?.slice(0, 100) || "(no task)";

    const agent: ManagedAgent = {
      id,
      process: proc,
      status: "starting",
      agentType: options.agentType,
      sessionFile,
      startTime: Date.now(),
      lastOutput: null,
      taskPreview,
      toolCount: 0,
      tokenCount: 0,
      pendingRequests: new Map(),
      requestCounter: 0,
      idleResolvers: new Set(),
    };

    this.agents.set(id, agent);

    // Set up stdout reader
    agent.stdoutCleanup = attachLineReader(proc.stdout!, (line) => {
      this.handleStdoutLine(id, line);
    });

    // Handle process exit
    proc.on("exit", (code) => {
      if (agent.status !== "closed") {
        if (code !== 0 && code !== null) {
          agent.status = "crashed";
          agent.error = `Process exited with code ${code}`;
        } else {
          agent.status = "closed";
        }
        this.resolveWaiters(agent);
        this.notifyUpdate(id);
      }
    });

    proc.on("error", (err) => {
      agent.status = "crashed";
      agent.error = err.message;
      this.resolveWaiters(agent);
      this.notifyUpdate(id);
    });

    // Collect stderr for error diagnostics
    let stderrBuf = "";
    proc.stderr?.on("data", (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 10_000) stderrBuf = stderrBuf.slice(-5_000);
    });

    // Wait briefly for process to initialize
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    if (proc.exitCode !== null) {
      agent.status = "crashed";
      agent.error = `Process exited immediately with code ${proc.exitCode}. ${stderrBuf}`;
      this.resolveWaiters(agent);
      throw new Error(agent.error);
    }

    // Send initial prompt
    agent.status = "streaming";
    writeRpcCommand(proc, { type: "prompt", message: options.message });
    this.notifyUpdate(id);

    return { agent_id: id, session_file: sessionFile };
  }

  // --------------------------------------------------------------------------
  // send_input
  // --------------------------------------------------------------------------

  async sendInput(
    id: string,
    message: string,
    interrupt?: boolean,
  ): Promise<{ status: AgentStatus }> {
    const agent = this.requireAgent(id);

    if (interrupt) {
      try {
        await sendRpcRequest(agent, { type: "abort" }, 5_000);
      } catch {
        // Abort is best-effort — agent may not be streaming
      }
    }

    const sent = writeRpcCommand(agent.process, { type: "prompt", message });
    if (!sent) {
      throw new Error(`Failed to send input to agent ${id} — stdin not writable`);
    }

    agent.status = "streaming";
    this.notifyUpdate(id);
    return { status: agent.status };
  }

  // --------------------------------------------------------------------------
  // wait
  // --------------------------------------------------------------------------

  async waitForAgents(options: WaitOptions): Promise<WaitResult> {
    const { ids, signal } = options;
    const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);

    // Validate all IDs exist
    for (const id of ids) {
      if (!this.agents.has(id) && !this.closedSessions.has(id)) {
        throw new Error(`Agent ${id} not found`);
      }
    }

    // Check if any are already in a final state
    const immediateResults = this.collectFinalStatuses(ids);
    if (immediateResults.size > 0) {
      // Fetch last output for idle agents
      await this.fetchLastOutputs(immediateResults);
      return {
        statuses: this.buildWaitStatuses(ids, immediateResults),
        timed_out: false,
      };
    }

    // Wait for any agent to reach a final state
    const result = await new Promise<{ resolved: Set<string>; timed_out: boolean }>((resolve) => {
      const resolved = new Set<string>();
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        for (const id of ids) {
          const agent = this.agents.get(id);
          if (agent) agent.idleResolvers.delete(resolver);
        }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      const resolver = () => {
        // Check which agents are now final
        for (const id of ids) {
          const agent = this.agents.get(id);
          if (agent && isFinalStatus(agent.status)) {
            resolved.add(id);
          }
        }
        if (resolved.size > 0) {
          cleanup();
          resolve({ resolved, timed_out: false });
        }
      };

      // Register on all non-final agents
      for (const id of ids) {
        const agent = this.agents.get(id);
        if (agent && !isFinalStatus(agent.status)) {
          agent.idleResolvers.add(resolver);
        }
      }

      const timeoutTimer = setTimeout(() => {
        cleanup();
        resolve({ resolved, timed_out: true });
      }, timeoutMs);

      const onAbort = () => {
        cleanup();
        resolve({ resolved, timed_out: true });
      };
      if (signal) {
        if (signal.aborted) {
          cleanup();
          resolve({ resolved, timed_out: true });
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    // Fetch last output for resolved agents
    await this.fetchLastOutputs(result.resolved);

    return {
      statuses: this.buildWaitStatuses(ids, result.resolved),
      timed_out: result.timed_out,
    };
  }

  // --------------------------------------------------------------------------
  // close
  // --------------------------------------------------------------------------

  async closeAgent(id: string): Promise<{ previous_status: AgentStatus }> {
    const agent = this.requireAgent(id);
    const previousStatus = agent.status;

    // Preserve session file for resume
    this.closedSessions.set(id, agent.sessionFile);

    // Stop the process
    await this.stopProcess(agent);

    agent.status = "closed";
    this.resolveWaiters(agent);
    this.agents.delete(id);
    this.notifyUpdate(id);

    return { previous_status: previousStatus };
  }

  // --------------------------------------------------------------------------
  // resume
  // --------------------------------------------------------------------------

  async resumeAgent(id: string): Promise<{ agent_id: string; session_file: string }> {
    const sessionFile = this.closedSessions.get(id);
    if (!sessionFile) {
      throw new Error(`No closed session found for agent ${id}`);
    }

    const currentDepth = getCurrentDepth();
    const maxDepth = getMaxDepth();
    if (currentDepth >= maxDepth) {
      throw new Error(
        `Agent depth limit reached (${currentDepth}/${maxDepth}). Cannot resume agent.`,
      );
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PI_SUBAGENT_DEPTH: String(currentDepth + 1),
    };

    const proc = spawn("pi", ["--mode", "rpc", "--session", sessionFile], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const agent: ManagedAgent = {
      id,
      process: proc,
      status: "starting",
      sessionFile,
      startTime: Date.now(),
      lastOutput: null,
      taskPreview: "(resumed)",
      toolCount: 0,
      tokenCount: 0,
      pendingRequests: new Map(),
      requestCounter: 0,
      idleResolvers: new Set(),
    };

    this.agents.set(id, agent);
    this.closedSessions.delete(id);

    agent.stdoutCleanup = attachLineReader(proc.stdout!, (line) => {
      this.handleStdoutLine(id, line);
    });

    proc.on("exit", (code) => {
      if (agent.status !== "closed") {
        agent.status = code !== 0 && code !== null ? "crashed" : "closed";
        if (code !== 0 && code !== null) agent.error = `Process exited with code ${code}`;
        this.resolveWaiters(agent);
        this.notifyUpdate(id);
      }
    });

    proc.on("error", (err) => {
      agent.status = "crashed";
      agent.error = err.message;
      this.resolveWaiters(agent);
      this.notifyUpdate(id);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    if (proc.exitCode !== null) {
      agent.status = "crashed";
      agent.error = `Process exited immediately with code ${proc.exitCode}`;
      throw new Error(agent.error);
    }

    agent.status = "idle";
    this.notifyUpdate(id);

    return { agent_id: id, session_file: sessionFile };
  }

  // --------------------------------------------------------------------------
  // cleanup
  // --------------------------------------------------------------------------

  async cleanup(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const [, agent] of this.agents) {
      stopPromises.push(this.stopProcess(agent));
    }
    await Promise.allSettled(stopPromises);
    this.agents.clear();
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private handleStdoutLine(agentId: string, line: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      return; // skip non-JSON lines
    }

    // RPC response — route to pending request
    if (data.type === "response" && data.id && agent.pendingRequests.has(data.id)) {
      const pending = agent.pendingRequests.get(data.id)!;
      agent.pendingRequests.delete(data.id);
      pending.resolve(data);
      return;
    }

    // Agent events — track status and progress
    switch (data.type) {
      case "agent_start":
        agent.status = "streaming";
        this.notifyUpdate(agentId);
        break;

      case "agent_end":
        agent.status = "idle";
        this.resolveWaiters(agent);
        this.notifyComplete(agentId, agent);
        this.notifyUpdate(agentId);
        break;

      case "tool_execution_start":
        agent.toolCount++;
        agent.currentActivity = formatToolActivity(data.toolName, data.args);
        this.notifyUpdate(agentId);
        break;

      case "tool_execution_end":
        agent.currentActivity = undefined;
        this.notifyUpdate(agentId);
        break;

      case "message_end":
        if (data.message?.role === "assistant") {
          // Track tokens
          const usage = data.message.usage;
          if (usage) {
            agent.tokenCount += (usage.input || 0) + (usage.output || 0);
          }
          // Cache last assistant text
          const textBlocks = (data.message.content || [])
            .filter((b: any) => b.type === "text" && b.text)
            .map((b: any) => b.text);
          if (textBlocks.length > 0) {
            agent.lastOutput = textBlocks.join("\n");
          }
        }
        this.notifyUpdate(agentId);
        break;
    }
  }

  private resolveWaiters(agent: ManagedAgent): void {
    for (const resolver of agent.idleResolvers) {
      resolver();
    }
    agent.idleResolvers.clear();
  }

  private notifyUpdate(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent && this.onAgentUpdate) {
      this.onAgentUpdate(agentId, agent);
    }
  }

  private notifyComplete(agentId: string, agent: ManagedAgent): void {
    if (this.onAgentComplete) {
      this.onAgentComplete(agentId, agent);
    }
  }

  private requireAgent(id: string): ManagedAgent {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent ${id} not found`);
    }
    if (agent.status === "closed" || agent.status === "crashed") {
      throw new Error(`Agent ${id} is ${agent.status}`);
    }
    return agent;
  }

  private collectFinalStatuses(ids: string[]): Set<string> {
    const final = new Set<string>();
    for (const id of ids) {
      const agent = this.agents.get(id);
      if (!agent || isFinalStatus(agent.status)) {
        final.add(id);
      }
    }
    return final;
  }

  private async fetchLastOutputs(agentIds: Set<string>): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const id of agentIds) {
      const agent = this.agents.get(id);
      if (agent && agent.status === "idle" && !agent.lastOutput) {
        promises.push(
          sendRpcRequest(agent, { type: "get_last_assistant_text" }, 5_000)
            .then((response) => {
              if (response.success && response.data?.text) {
                agent.lastOutput = response.data.text;
              }
            })
            .catch(() => {
              // Best effort — we may already have lastOutput from events
            }),
        );
      }
    }
    await Promise.allSettled(promises);
  }

  private buildWaitStatuses(
    requestedIds: string[],
    resolvedIds: Set<string>,
  ): Record<string, WaitAgentEntry> {
    const statuses: Record<string, WaitAgentEntry> = {};
    for (const id of requestedIds) {
      const agent = this.agents.get(id);
      if (agent) {
        statuses[id] = {
          status: agent.status,
          last_response: isFinalStatus(agent.status) ? agent.lastOutput : null,
        };
      } else if (this.closedSessions.has(id)) {
        statuses[id] = { status: "closed", last_response: null };
      } else {
        statuses[id] = { status: "crashed", last_response: null };
      }
    }
    return statuses;
  }

  private async stopProcess(agent: ManagedAgent): Promise<void> {
    agent.stdoutCleanup?.();
    agent.stdoutCleanup = undefined;

    // Reject all pending requests
    for (const [, pending] of agent.pendingRequests) {
      pending.reject(new Error("Agent shutting down"));
    }
    agent.pendingRequests.clear();

    if (agent.process.exitCode !== null) return; // already exited

    agent.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (agent.process.exitCode === null) {
          agent.process.kill("SIGKILL");
        }
        resolve();
      }, 3_000);
      agent.process.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function clampTimeout(ms: number): number {
  if (ms <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.max(MIN_WAIT_TIMEOUT_MS, Math.min(ms, MAX_WAIT_TIMEOUT_MS));
}

function formatToolActivity(toolName?: string, args?: any): string {
  if (!toolName) return "working…";
  if (toolName === "read" && args?.path) return `Read: ${args.path}`;
  if (toolName === "edit" && args?.path) return `Edit: ${args.path}`;
  if (toolName === "write" && args?.path) return `Write: ${args.path}`;
  if (toolName === "bash" && args?.command) {
    const cmd = String(args.command).split("\n")[0].slice(0, 60);
    return `Bash: ${cmd}`;
  }
  if (toolName === "grep" && args?.pattern) return `Grep: ${args.pattern}`;
  if (toolName === "find") return `Find: ${args?.glob || args?.path || "…"}`;
  return toolName;
}
