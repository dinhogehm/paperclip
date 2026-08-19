import { describe, expect, it } from "vitest";
import { mergeRuntimeConfigPreservingHeartbeat } from "./runtime-config-heartbeat.js";

const liveHeartbeat = {
  enabled: true,
  intervalSec: 900,
  cooldownSec: 60,
  wakeOnDemand: true,
  maxConcurrentRuns: 1,
};

describe("mergeRuntimeConfigPreservingHeartbeat", () => {
  it("keeps the existing live heartbeat when the incoming patch omits it", () => {
    const next = mergeRuntimeConfigPreservingHeartbeat(
      { heartbeat: liveHeartbeat, model: "keep-me" },
      { model: "new-model" },
      "agent",
    );

    expect(next.heartbeat).toEqual(liveHeartbeat);
    expect(next.model).toBe("new-model");
  });

  it("does not let an agent disable or zero a live timer", () => {
    const next = mergeRuntimeConfigPreservingHeartbeat(
      { heartbeat: liveHeartbeat },
      { heartbeat: { enabled: false, intervalSec: 0, maxConcurrentRuns: 2 } },
      "agent",
    );

    expect(next.heartbeat).toMatchObject({
      enabled: true,
      intervalSec: 900,
      maxConcurrentRuns: 2,
    });
  });

  it("lets a board user turn the timer off", () => {
    const next = mergeRuntimeConfigPreservingHeartbeat(
      { heartbeat: liveHeartbeat },
      { heartbeat: { enabled: false, intervalSec: 0 } },
      "user",
    );

    expect(next.heartbeat).toEqual({ enabled: false, intervalSec: 0 });
  });

  it("does not invent a heartbeat when none existed", () => {
    const next = mergeRuntimeConfigPreservingHeartbeat(
      { modelProfiles: { cheap: { enabled: false } } },
      { modelProfiles: { cheap: { enabled: true } } },
      "agent",
    );

    expect(next.heartbeat).toBeUndefined();
  });
});
