import type { ChildProcess } from "node:child_process";

// ============================================================================
// Agent Status
// ============================================================================

export type AgentStatus = "starting" | "streaming" | "idle" | "closed" | "crashed";

export function isFinalStatus(status: AgentStatus): boolean {
  return status === "idle" || status === "closed" || status === "crashed";
}

// ============================================================================
// Managed Agent
// ============================================================================

export interface ManagedAgent {
  id: string;
  process: ChildProcess;
  status: AgentStatus;
  agentType?: string;
  sessionFile: string;
  startTime: number;
  lastOutput: string | null;
  error?: string;
  taskPreview: string;

  // Live progress (for widget)
  toolCount: number;
  tokenCount: number;
  currentActivity?: string;

  // RPC request-response correlation
  pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>;
  requestCounter: number;

  // Wait resolution
  idleResolvers: Set<() => void>;

  // Cleanup
  stdoutCleanup?: () => void;
}

// ============================================================================
// Tool Results
// ============================================================================

export interface SpawnAgentDetails {
  agent_id: string;
  agent_type?: string;
  session_file: string;
}

export interface SendInputDetails {
  agent_id: string;
  status: AgentStatus;
}

export interface WaitAgentEntry {
  status: AgentStatus;
  last_response: string | null;
}

export interface WaitAgentDetails {
  statuses: Record<string, WaitAgentEntry>;
  timed_out: boolean;
}

export interface CloseAgentDetails {
  agent_id: string;
  previous_status: AgentStatus;
}

export interface ResumeAgentDetails {
  agent_id: string;
  status: AgentStatus;
  session_file: string;
}

// ============================================================================
// RPC Types (subset of pi's RPC protocol)
// ============================================================================

export interface RpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 3_600_000;

export function getCurrentDepth(): number {
  return parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);
}

export function getMaxDepth(): number {
  return parseInt(process.env.PI_SUBAGENT_MAX_DEPTH || String(DEFAULT_MAX_DEPTH), 10);
}
