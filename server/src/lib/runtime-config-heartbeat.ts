import { readObject } from "./objects.ts";

export type HeartbeatPreserveActor = "user" | "agent";

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function isLiveHeartbeat(heartbeat: unknown): boolean {
  const record = readObject(heartbeat);
  if (!record) return false;
  if (record.enabled !== true && record.enabled !== "true") return false;
  const intervalSec = parseFiniteNumber(record.intervalSec);
  return intervalSec !== null && intervalSec > 0;
}

export function mergeRuntimeConfigPreservingHeartbeat(
  existing: unknown,
  incoming: unknown,
  actorType: HeartbeatPreserveActor = "agent",
): Record<string, unknown> {
  const existingRc = readObject(existing) ?? {};
  const incomingRc = readObject(incoming) ?? {};
  const next = { ...incomingRc };

  if (!Object.prototype.hasOwnProperty.call(incomingRc, "heartbeat")) {
    if (Object.prototype.hasOwnProperty.call(existingRc, "heartbeat")) {
      next.heartbeat = existingRc.heartbeat;
    }
    return next;
  }

  const existingHb = readObject(existingRc.heartbeat);
  if (actorType !== "agent" || !isLiveHeartbeat(existingHb)) {
    return next;
  }

  const incomingHb = readObject(incomingRc.heartbeat) ?? {};
  const merged = { ...existingHb, ...incomingHb, enabled: true };
  const intervalSec = parseFiniteNumber(merged.intervalSec);
  if (intervalSec === null || intervalSec <= 0) {
    merged.intervalSec = existingHb?.intervalSec;
  }
  next.heartbeat = merged;
  return next;
}
