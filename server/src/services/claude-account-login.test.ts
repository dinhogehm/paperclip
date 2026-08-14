import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { claudeAccountService } from "./claude-accounts.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";

function fakeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ id: accountId, companyId, name: "Claude Max" }])),
      })),
    })),
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writable: true,
    write: vi.fn((_chunk: string, _encoding: string, callback: (error?: Error | null) => void) => {
      callback(null);
      return true;
    }),
  };
  child.kill = vi.fn();
  return child;
}

describe("Claude account login browser-code forwarding", () => {
  let paperclipHome: string;
  let originalHome: string | undefined;
  let child: ReturnType<typeof fakeChild>;

  beforeEach(async () => {
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-"));
    originalHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = paperclipHome;
    child = fakeChild();
    spawnMock.mockReturnValue(child);
  });

  afterEach(async () => {
    if (child.listenerCount("error") > 0) child.emit("error", new Error("test cleanup"));
    spawnMock.mockReset();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  async function startLoginWithState(service: ReturnType<typeof claudeAccountService>, state: string) {
    const pending = service.startLogin(companyId, accountId);
    for (let attempt = 0; attempt < 20 && child.stdout.listenerCount("data") === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    child.stdout.emit("data", `Open https://platform.claude.com/oauth/authorize?state=${state}\n`);
    return pending;
  }

  it("pipes the one-time value to Claude stdin and returns only non-sensitive state", async () => {
    const service = claudeAccountService(fakeDb() as never);
    const started = await startLoginWithState(service, "example-state");
    expect(started.acceptsBrowserCode).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["auth", "login", "--claudeai"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );

    const browserCode = "example-code#example-state";
    const state = await service.submitLoginCode(companyId, accountId, browserCode);

    expect(child.stdin.write).toHaveBeenCalledWith(`${browserCode}\n`, "utf8", expect.any(Function));
    expect(state).toMatchObject({
      status: "waiting_for_user",
      acceptsBrowserCode: false,
      browserCodeSubmitted: true,
    });
    expect(JSON.stringify(state)).not.toContain(browserCode);
  });

  it("does not accept a browser code before Claude provides a state-bound verification URL", async () => {
    const service = claudeAccountService(fakeDb() as never);
    const started = await service.startLogin(companyId, accountId);

    expect(started).toMatchObject({
      status: "waiting_for_user",
      verificationUrl: null,
      acceptsBrowserCode: false,
    });
    await expect(service.submitLoginCode(companyId, accountId, "example-code#example-state"))
      .rejects.toMatchObject({ status: 409 });
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it("rejects a code from another OAuth attempt without terminating the active session", async () => {
    const service = claudeAccountService(fakeDb() as never);
    await startLoginWithState(service, "current-state");

    await expect(service.submitLoginCode(companyId, accountId, "example-code#stale-state"))
      .rejects.toMatchObject({ status: 409 });
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    const state = await service.submitLoginCode(companyId, accountId, "example-code#current-state");
    expect(state).toMatchObject({ browserCodeSubmitted: true, acceptsBrowserCode: false });
  });

  it("requires an active company-scoped login session", async () => {
    const service = claudeAccountService(fakeDb() as never);
    await expect(service.submitLoginCode(companyId, accountId, "example-code#example-state"))
      .rejects.toMatchObject({ status: 409 });
  });
});
