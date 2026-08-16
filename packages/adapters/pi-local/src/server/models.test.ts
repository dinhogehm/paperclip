import { afterEach, describe, expect, it, vi } from "vitest";

const runChildProcessMock = vi.hoisted(() => vi.fn(async (
  _runId: string,
  command: string,
  _args: string[],
  _options: unknown,
) => {
  if (command.includes("__paperclip_missing_")) throw new Error("command unavailable");
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess: runChildProcessMock };
});

import {
  discoverPiModels,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    vi.clearAllMocks();
    resetPiModelsCacheForTests();
  });

  it("keeps host credentials out of model probes while preserving explicit bindings", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.NODE_ENV = "production";
    process.env.GITHUB_TOKEN = "github-host-secret";

    try {
      await discoverPiModels({
        command: "pi-fixture",
        env: {
          NODE_ENV: "test",
          OPENAI_API_KEY: "openai-explicit-binding",
        },
      });

      const options = runChildProcessMock.mock.calls.at(-1)?.[3] as { env: Record<string, string> } | undefined;
      expect(options?.env.NODE_ENV).toBe("test");
      expect(options?.env.OPENAI_API_KEY).toBe("openai-explicit-binding");
      expect(options?.env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithubToken;
    }
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });
});
