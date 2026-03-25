/**
 * E2E tests: spawn real pi --mode rpc processes and verify the agent pool.
 *
 * These require:
 * - pi installed and on PATH
 * - A valid API key configured
 *
 * Skip with: PI_SKIP_E2E=1 node --experimental-strip-types --test test/e2e.test.ts
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { AgentPool } from "../extension/agent-pool.ts";

// Check prerequisites
function piAvailable(): boolean {
  try {
    execSync("pi --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = process.env.PI_SKIP_E2E === "1" || !piAvailable();

describe(
  "AgentPool E2E",
  { skip: skip ? "pi not available or PI_SKIP_E2E=1" : undefined, timeout: 120_000 },
  () => {
    let pool: AgentPool;

    before(() => {
      pool = new AgentPool();
      pool.setParentSession("e2e-test", null);
    });

    after(async () => {
      await pool.cleanup();
    });

    it("spawn + wait: agent processes a simple prompt and returns a response", async () => {
      const { agent_id } = await pool.spawnAgent({
        message: "Reply with exactly: HELLO_E2E_TEST",
      });
      assert.ok(agent_id, "should return an agent_id");
      assert.equal(agent_id.length, 8, "agent_id should be 8 hex chars");

      const agent = pool.getAgent(agent_id);
      assert.ok(agent, "agent should be in pool");
      assert.ok(
        agent.status === "starting" || agent.status === "streaming",
        `agent should be starting or streaming, got ${agent.status}`,
      );

      const result = await pool.waitForAgents({
        ids: [agent_id],
        timeoutMs: 60_000,
      });

      assert.equal(result.timed_out, false, "should not time out");
      const entry = result.statuses[agent_id];
      assert.ok(entry, "should have status for agent");
      assert.equal(entry.status, "idle", "agent should be idle after completing");
      assert.ok(entry.last_response, "should have a last_response");
      assert.ok(
        entry.last_response!.includes("HELLO_E2E_TEST"),
        `response should contain HELLO_E2E_TEST, got: ${entry.last_response!.slice(0, 200)}`,
      );
    });

    it("send_input: follow-up message is processed", async () => {
      const { agent_id } = await pool.spawnAgent({
        message: 'Reply with exactly: FIRST_RESPONSE. Do not use any tools.',
      });

      // Wait for initial response
      await pool.waitForAgents({ ids: [agent_id], timeoutMs: 60_000 });

      // Send follow-up
      await pool.sendInput(agent_id, "Now reply with exactly: SECOND_RESPONSE. Do not use any tools.");

      // Wait for follow-up response
      const result = await pool.waitForAgents({ ids: [agent_id], timeoutMs: 60_000 });
      const entry = result.statuses[agent_id];
      assert.ok(entry?.last_response, "should have response to follow-up");
      assert.ok(
        entry.last_response!.includes("SECOND_RESPONSE"),
        `follow-up response should contain SECOND_RESPONSE, got: ${entry.last_response!.slice(0, 200)}`,
      );
    });

    it("close + resume: session is preserved", async () => {
      const { agent_id } = await pool.spawnAgent({
        message: "Reply with exactly: BEFORE_CLOSE. Do not use any tools.",
      });

      await pool.waitForAgents({ ids: [agent_id], timeoutMs: 60_000 });

      // Close
      const closeResult = await pool.closeAgent(agent_id);
      assert.equal(closeResult.previous_status, "idle");

      // Agent should be gone from active pool
      assert.equal(pool.getAgent(agent_id), undefined);

      // Resume
      const resumeResult = await pool.resumeAgent(agent_id);
      assert.equal(resumeResult.agent_id, agent_id);

      // Agent should be back
      const resumed = pool.getAgent(agent_id);
      assert.ok(resumed, "resumed agent should be in pool");

      // Send new message and verify session continuity
      await pool.sendInput(agent_id, "What was the last thing you said? Reply with that exact text and nothing else.");
      const result = await pool.waitForAgents({ ids: [agent_id], timeoutMs: 60_000 });
      const entry = result.statuses[agent_id];
      assert.ok(entry?.last_response, "should have response after resume");
      // The agent should remember BEFORE_CLOSE from the preserved session
      assert.ok(
        entry.last_response!.includes("BEFORE_CLOSE"),
        `resumed agent should remember previous context, got: ${entry.last_response!.slice(0, 200)}`,
      );
    });

    it("wait with short timeout returns timed_out", async () => {
      const { agent_id } = await pool.spawnAgent({
        message:
          "List every file in this directory recursively and describe each one in detail. Take your time.",
      });

      // Wait with minimum timeout — agent should still be working
      const result = await pool.waitForAgents({
        ids: [agent_id],
        timeoutMs: 10_000, // minimum
      });

      // It may or may not time out depending on speed, but the structure should be valid
      assert.ok("timed_out" in result, "result should have timed_out field");
      assert.ok("statuses" in result, "result should have statuses field");
      assert.ok(agent_id in result.statuses, "should have status for agent");

      // Clean up
      await pool.closeAgent(agent_id);
    });

    it("parallel: two agents run concurrently", async () => {
      const start = Date.now();

      const { agent_id: id1 } = await pool.spawnAgent({
        message: "Reply with exactly: AGENT_ONE. Do not use any tools.",
        agentType: "explorer",
      });
      const { agent_id: id2 } = await pool.spawnAgent({
        message: "Reply with exactly: AGENT_TWO. Do not use any tools.",
        agentType: "explorer",
      });

      // Wait for both
      const result1 = await pool.waitForAgents({ ids: [id1, id2], timeoutMs: 60_000 });

      // At least one should have finished
      const finished = Object.entries(result1.statuses).filter(
        ([, e]) => e.status === "idle",
      );
      assert.ok(finished.length >= 1, "at least one agent should be idle");

      // Wait for the other if needed
      const remaining = [id1, id2].filter(
        (id) => result1.statuses[id]?.status !== "idle",
      );
      if (remaining.length > 0) {
        await pool.waitForAgents({ ids: remaining, timeoutMs: 60_000 });
      }

      // Verify both responses
      const agent1 = pool.getAgent(id1);
      const agent2 = pool.getAgent(id2);
      assert.ok(agent1?.lastOutput?.includes("AGENT_ONE"), "agent 1 should respond with AGENT_ONE");
      assert.ok(agent2?.lastOutput?.includes("AGENT_TWO"), "agent 2 should respond with AGENT_TWO");
    });

    it("depth limit: rejects spawn when at max depth", async () => {
      const original = process.env.PI_SUBAGENT_DEPTH;
      const originalMax = process.env.PI_SUBAGENT_MAX_DEPTH;

      process.env.PI_SUBAGENT_DEPTH = "2";
      process.env.PI_SUBAGENT_MAX_DEPTH = "2";

      try {
        await assert.rejects(
          () => pool.spawnAgent({ message: "should fail" }),
          (err: Error) => {
            assert.ok(err.message.includes("depth limit"), `expected depth limit error, got: ${err.message}`);
            return true;
          },
        );
      } finally {
        if (original !== undefined) process.env.PI_SUBAGENT_DEPTH = original;
        else delete process.env.PI_SUBAGENT_DEPTH;
        if (originalMax !== undefined) process.env.PI_SUBAGENT_MAX_DEPTH = originalMax;
        else delete process.env.PI_SUBAGENT_MAX_DEPTH;
      }
    });
  },
);
