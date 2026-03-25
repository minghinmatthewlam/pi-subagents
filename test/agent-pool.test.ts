import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentDepth,
  getMaxDepth,
  isFinalStatus,
  DEFAULT_MAX_DEPTH,
  DEFAULT_WAIT_TIMEOUT_MS,
  MIN_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
} from "../extension/types.ts";

// ============================================================================
// types.ts unit tests
// ============================================================================

describe("types", () => {
  describe("isFinalStatus", () => {
    it("idle is final", () => {
      assert.equal(isFinalStatus("idle"), true);
    });
    it("closed is final", () => {
      assert.equal(isFinalStatus("closed"), true);
    });
    it("crashed is final", () => {
      assert.equal(isFinalStatus("crashed"), true);
    });
    it("starting is not final", () => {
      assert.equal(isFinalStatus("starting"), false);
    });
    it("streaming is not final", () => {
      assert.equal(isFinalStatus("streaming"), false);
    });
  });

  describe("getCurrentDepth", () => {
    const original = process.env.PI_SUBAGENT_DEPTH;

    beforeEach(() => {
      delete process.env.PI_SUBAGENT_DEPTH;
    });

    it("defaults to 0 when env not set", () => {
      delete process.env.PI_SUBAGENT_DEPTH;
      assert.equal(getCurrentDepth(), 0);
    });

    it("reads from env", () => {
      process.env.PI_SUBAGENT_DEPTH = "3";
      assert.equal(getCurrentDepth(), 3);
      // restore
      if (original !== undefined) process.env.PI_SUBAGENT_DEPTH = original;
      else delete process.env.PI_SUBAGENT_DEPTH;
    });
  });

  describe("getMaxDepth", () => {
    const original = process.env.PI_SUBAGENT_MAX_DEPTH;

    beforeEach(() => {
      delete process.env.PI_SUBAGENT_MAX_DEPTH;
    });

    it("defaults to DEFAULT_MAX_DEPTH when env not set", () => {
      delete process.env.PI_SUBAGENT_MAX_DEPTH;
      assert.equal(getMaxDepth(), DEFAULT_MAX_DEPTH);
    });

    it("reads from env", () => {
      process.env.PI_SUBAGENT_MAX_DEPTH = "5";
      assert.equal(getMaxDepth(), 5);
      // restore
      if (original !== undefined) process.env.PI_SUBAGENT_MAX_DEPTH = original;
      else delete process.env.PI_SUBAGENT_MAX_DEPTH;
    });
  });

  describe("constants", () => {
    it("DEFAULT_MAX_DEPTH is 2", () => {
      assert.equal(DEFAULT_MAX_DEPTH, 2);
    });
    it("DEFAULT_WAIT_TIMEOUT_MS is 30s", () => {
      assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 30_000);
    });
    it("MIN_WAIT_TIMEOUT_MS is 10s", () => {
      assert.equal(MIN_WAIT_TIMEOUT_MS, 10_000);
    });
    it("MAX_WAIT_TIMEOUT_MS is 1h", () => {
      assert.equal(MAX_WAIT_TIMEOUT_MS, 3_600_000);
    });
  });
});
