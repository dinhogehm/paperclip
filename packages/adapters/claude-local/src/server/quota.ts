import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_SOURCE_OAUTH = "anthropic-oauth";
const CLAUDE_USAGE_SOURCE_CLI = "claude-cli";

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function hasNonEmptyProcessEnv(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function createClaudeQuotaEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  return env;
}

function stripBackspaces(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\b") {
      out = out.slice(0, -1);
    } else {
      out += char;
    }
  }
  return out;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function cleanTerminalText(text: string): string {
  return stripAnsi(stripBackspaces(text))
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n");
}

function normalizeForLabelSearch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function trimToLatestUsagePanel(text: string): string | null {
  const lower = text.toLowerCase();
  const settingsIndex = lower.lastIndexOf("settings:");
  if (settingsIndex < 0) return null;
  let tail = text.slice(settingsIndex);
  const tailLower = tail.toLowerCase();
  if (!tailLower.includes("usage")) return null;
  if (!tailLower.includes("current session") && !tailLower.includes("loading usage")) return null;
  const stopMarkers = [
    "status dialog dismissed",
    "checking for updates",
    "press ctrl-c again to exit",
  ];
  let stopIndex = -1;
  for (const marker of stopMarkers) {
    const markerIndex = tailLower.indexOf(marker);
    if (markerIndex >= 0 && (stopIndex === -1 || markerIndex < stopIndex)) {
      stopIndex = markerIndex;
    }
  }
  if (stopIndex >= 0) {
    tail = tail.slice(0, stopIndex);
  }
  return tail;
}

function parseClaudeOAuthAccessToken(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const oauth = obj["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) return null;
  const token = (oauth as Record<string, unknown>)["accessToken"];
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function readClaudeTokenFromFile(credPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credPath, "utf8");
  } catch {
    return null;
  }
  return parseClaudeOAuthAccessToken(raw);
}

/** Claude Code stores subscription tokens in the macOS keychain as
 * `Claude Code-credentials-<sha256(configDir)[0:8]>` (and sometimes the unhashed service). */
export function claudeKeychainCredentialServiceName(configDir: string): string {
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

async function readClaudeTokenFromMacKeychain(configDir: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const services = [
    claudeKeychainCredentialServiceName(configDir),
    "Claude Code-credentials",
  ];
  const account = os.userInfo().username;
  for (const service of services) {
    for (const args of [
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      ["find-generic-password", "-s", service, "-w"],
    ]) {
      try {
        const { stdout } = await execFileAsync("security", args, {
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
        });
        const token = parseClaudeOAuthAccessToken(stdout.trim());
        if (token) return token;
      } catch {
        // try next lookup shape
      }
    }
  }
  return null;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export async function readClaudeAuthStatus(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeAuthStatus | null> {
  try {
    const executable = env.PAPERCLIP_CLAUDE_EXECUTABLE?.trim() || "claude";
    const { stdout } = await execFileAsync(executable, ["auth", "status"], {
      env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

function describeClaudeSubscriptionAuth(status: ClaudeAuthStatus | null): string | null {
  if (!status?.loggedIn || status.authMethod !== "claude.ai") return null;
  return status.subscriptionType
    ? `Claude is logged in via claude.ai (${status.subscriptionType})`
    : "Claude is logged in via claude.ai";
}

export async function readClaudeToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configDir = claudeConfigDir(env);
  for (const filename of [".credentials.json", "credentials.json"]) {
    const token = await readClaudeTokenFromFile(path.join(configDir, filename));
    if (token) return token;
  }
  return readClaudeTokenFromMacKeychain(configDir);
}

interface AnthropicUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface AnthropicExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  extra_usage?: AnthropicExtraUsage | null;
}

function formatCurrencyAmount(value: number, currency: string | null | undefined): string {
  const code = typeof currency === "string" && currency.trim().length > 0 ? currency.trim().toUpperCase() : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatExtraUsageLabel(extraUsage: AnthropicExtraUsage): string | null {
  const monthlyLimit = extraUsage.monthly_limit;
  const usedCredits = extraUsage.used_credits;
  if (
    typeof monthlyLimit !== "number" ||
    !Number.isFinite(monthlyLimit) ||
    typeof usedCredits !== "number" ||
    !Number.isFinite(usedCredits)
  ) {
    return null;
  }
  // API returns values in cents — convert to dollars for display
  return `${formatCurrencyAmount(usedCredits / 100, extraUsage.currency)} / ${formatCurrencyAmount(monthlyLimit / 100, extraUsage.currency)}`;
}

/** Convert a utilization value to a 0-100 integer percent. Returns null for null/undefined input.
 *  Handles both 0-1 fractions (legacy) and 0-100 percentages (current API). */
export function toPercent(utilization: number | null | undefined): number | null {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

/** fetch with an abort-based timeout so a hanging provider api doesn't block the response indefinitely */
export async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const CLAUDE_SESSION_LIMIT_LABEL = "Session limit (5h)";
const CLAUDE_WEEKLY_LIMIT_LABEL = "Weekly limit";
const CLAUDE_MONTHLY_LIMIT_LABEL = "Monthly limit";
const CLAUDE_WEEKLY_SONNET_LABEL = "Weekly limit (Sonnet only)";
const CLAUDE_WEEKLY_OPUS_LABEL = "Weekly limit (Opus only)";
const CLAUDE_PRIMARY_QUOTA_LABELS = [
  CLAUDE_SESSION_LIMIT_LABEL,
  CLAUDE_WEEKLY_LIMIT_LABEL,
  CLAUDE_MONTHLY_LIMIT_LABEL,
] as const;

function unavailableClaudeWindow(label: string): QuotaWindow {
  return {
    label,
    usedPercent: null,
    resetsAt: null,
    valueLabel: "Unavailable",
    detail: "Usage not reported for this window",
  };
}

/** Keep Session / Weekly / Monthly first and always present for UI parity with Codex. */
export function withClaudePrimaryQuotaWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const byLabel = new Map(windows.map((window) => [window.label, window]));
  const primary = CLAUDE_PRIMARY_QUOTA_LABELS.map(
    (label) => byLabel.get(label) ?? unavailableClaudeWindow(label),
  );
  const secondary = windows.filter(
    (window) => !(CLAUDE_PRIMARY_QUOTA_LABELS as readonly string[]).includes(window.label),
  );
  return [...primary, ...secondary];
}

export async function fetchClaudeQuota(token: string): Promise<QuotaWindow[]> {
  const resp = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!resp.ok) throw new Error(`anthropic usage api returned ${resp.status}`);
  const body = (await resp.json()) as AnthropicUsageResponse;
  const windows: QuotaWindow[] = [];

  if (body.five_hour != null) {
    windows.push({
      label: CLAUDE_SESSION_LIMIT_LABEL,
      usedPercent: toPercent(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day != null) {
    windows.push({
      label: CLAUDE_WEEKLY_LIMIT_LABEL,
      usedPercent: toPercent(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_sonnet != null) {
    windows.push({
      label: CLAUDE_WEEKLY_SONNET_LABEL,
      usedPercent: toPercent(body.seven_day_sonnet.utilization),
      resetsAt: body.seven_day_sonnet.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_opus != null) {
    windows.push({
      label: CLAUDE_WEEKLY_OPUS_LABEL,
      usedPercent: toPercent(body.seven_day_opus.utilization),
      resetsAt: body.seven_day_opus.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.extra_usage != null) {
    windows.push({
      label: CLAUDE_MONTHLY_LIMIT_LABEL,
      usedPercent: body.extra_usage.is_enabled === false ? null : toPercent(body.extra_usage.utilization),
      resetsAt: null,
      valueLabel:
        body.extra_usage.is_enabled === false
          ? "Not enabled"
          : formatExtraUsageLabel(body.extra_usage),
      detail:
        body.extra_usage.is_enabled === false
          ? "Monthly extra usage not enabled"
          : "Monthly extra usage pool",
    });
  }
  return withClaudePrimaryQuotaWindows(windows);
}

function usageOutputLooksRelevant(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  return normalized.includes("currentsession")
    || normalized.includes("currentweek")
    || normalized.includes("loadingusage")
    || normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited");
}

function usageOutputLooksComplete(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  if (
    normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited")
  ) {
    return true;
  }
  return normalized.includes("currentsession")
    && (normalized.includes("currentweek") || normalized.includes("extrausage"))
    && /[0-9]{1,3}(?:\.[0-9]+)?%/i.test(text);
}

function extractUsageError(text: string): string | null {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (lower.includes("token_expired") || lower.includes("token has expired")) {
    return "Claude CLI token expired. Run `claude login` to refresh.";
  }
  if (lower.includes("authentication_error")) {
    return "Claude CLI authentication error. Run `claude login`.";
  }
  if (lower.includes("rate_limit_error") || lower.includes("rate limited") || compact.includes("ratelimited")) {
    return "Claude CLI usage endpoint is rate limited right now. Please try again later.";
  }
  if (lower.includes("failed to load usage data") || compact.includes("failedtoloadusagedata")) {
    return "Claude CLI could not load usage data. Open the CLI and retry `/usage`.";
  }
  return null;
}

function percentFromLine(line: string): number | null {
  const match = line.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const rawValue = Number(match[1]);
  if (!Number.isFinite(rawValue)) return null;
  const clamped = Math.min(100, Math.max(0, rawValue));
  const lower = line.toLowerCase();
  if (lower.includes("remaining") || lower.includes("left") || lower.includes("available")) {
    return Math.max(0, Math.min(100, Math.round(100 - clamped)));
  }
  return Math.round(clamped);
}

function isQuotaLabel(line: string): boolean {
  const normalized = normalizeForLabelSearch(line);
  return normalized === "currentsession"
    || normalized === "sessionlimit5h"
    || normalized === "currentweekallmodels"
    || normalized === "weeklylimit"
    || normalized === "currentweeksonnetonly"
    || normalized === "currentweeksonnet"
    || normalized === "weeklylimitsonnetonly"
    || normalized === "currentweekopusonly"
    || normalized === "currentweekopus"
    || normalized === "weeklylimitopusonly"
    || normalized === "extrausage"
    || normalized === "monthlylimit";
}

function canonicalQuotaLabel(line: string): string {
  switch (normalizeForLabelSearch(line)) {
    case "currentsession":
    case "sessionlimit5h":
      return CLAUDE_SESSION_LIMIT_LABEL;
    case "currentweekallmodels":
    case "weeklylimit":
      return CLAUDE_WEEKLY_LIMIT_LABEL;
    case "currentweeksonnetonly":
    case "currentweeksonnet":
    case "weeklylimitsonnetonly":
      return CLAUDE_WEEKLY_SONNET_LABEL;
    case "currentweekopusonly":
    case "currentweekopus":
    case "weeklylimitopusonly":
      return CLAUDE_WEEKLY_OPUS_LABEL;
    case "extrausage":
    case "monthlylimit":
      return CLAUDE_MONTHLY_LIMIT_LABEL;
    default:
      return line;
  }
}

function formatClaudeCliDetail(label: string, lines: string[]): string | null {
  const normalizedLabel = normalizeForLabelSearch(label);
  if (normalizedLabel === "extrausage" || normalizedLabel === "monthlylimit") {
    const compact = lines.join(" ").replace(/\s+/g, "").toLowerCase();
    if (compact.includes("extrausagenotenabled")) {
      return "Monthly extra usage not enabled • /extra-usage to enable";
    }
    const firstLine = lines.find((line) => line.trim().length > 0) ?? null;
    return firstLine;
  }

  const resetLine = lines.find((line) => /^resets/i.test(line) || normalizeForLabelSearch(line).startsWith("resets"));
  if (!resetLine) return null;
  return resetLine
    .replace(/^Resets/i, "Resets ")
    .replace(/([A-Z][a-z]{2})(\d)/g, "$1 $2")
    .replace(/(\d)at(\d)/g, "$1 at $2")
    .replace(/(am|pm)\(/gi, "$1 (")
    .replace(/([A-Za-z])\(/g, "$1 (")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseClaudeCliUsageText(text: string): QuotaWindow[] {
  const cleaned = trimToLatestUsagePanel(cleanTerminalText(text)) ?? cleanTerminalText(text);
  const usageError = extractUsageError(cleaned);
  if (usageError) throw new Error(usageError);

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections: Array<{ label: string; lines: string[] }> = [];
  let current: { label: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isQuotaLabel(line)) {
      if (current) sections.push(current);
      current = { label: canonicalQuotaLabel(line), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const windows = sections.map<QuotaWindow>((section) => {
    const usedPercent = section.lines.map(percentFromLine).find((value) => value != null) ?? null;
    return {
      label: section.label,
      usedPercent,
      resetsAt: null,
      valueLabel: null,
      detail: formatClaudeCliDetail(section.label, section.lines),
    };
  });

  if (!windows.some((window) => normalizeForLabelSearch(window.label) === "sessionlimit5h")) {
    throw new Error("Could not parse Claude CLI usage output.");
  }
  return withClaudePrimaryQuotaWindows(windows);
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildClaudeCliShellProbeCommand(executable = "claude"): string {
  const feed = "(sleep 2; printf '/usage\\r'; sleep 6; printf '\\033'; sleep 1; printf '\\003')";
  const claudeCommand = `${quoteForShell(executable)} --tools \"\"`;
  if (process.platform === "darwin") {
    return `${feed} | script -q /dev/null ${claudeCommand}`;
  }
  return `${feed} | script -q -e -f -c ${quoteForShell(claudeCommand)} /dev/null`;
}

function capturedProbeError(message: string, stdout: string, stderr: string): Error {
  return Object.assign(new Error(message), { stdout, stderr });
}

export async function captureClaudeCliUsageText(
  timeoutMs = 12_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const command = buildClaudeCliShellProbeCommand(
    env.PAPERCLIP_CLAUDE_EXECUTABLE?.trim() || "claude",
  );
  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      // Keep the shell pipeline: on macOS, `script` rejects the socket-backed
      // stdin created by Node's `stdio: "pipe"`. A detached shell gives the
      // feeder and `script` a stable process group; terminating `script` also
      // closes its PTY and hangs up the Claude child.
      const child = spawn("sh", ["-c", command], {
        env: createClaudeQuotaEnv(env),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const maxChars = 8 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const append = (current: string, chunk: Buffer | string) => {
        const next = `${current}${String(chunk)}`;
        return next.length > maxChars ? next.slice(-maxChars) : next;
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

      const terminateGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The process group already exited.
        }
      };
      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      };
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateGroup("SIGTERM");
        forceKillTimer = setTimeout(() => terminateGroup("SIGKILL"), 1_000);
        forceKillTimer.unref?.();
      }, Math.max(1, timeoutMs));

      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (timedOut) {
          // The shell can exit on SIGTERM while a descendant ignores it. Kill
          // any remaining members before cleanup cancels the escalation timer.
          terminateGroup("SIGKILL");
          finish(capturedProbeError(
            `Claude CLI usage probe timed out after ${timeoutMs}ms`,
            stdout,
            stderr,
          ));
        } else if (code === 0) {
          finish();
        } else {
          finish(capturedProbeError(
            `Claude CLI usage probe exited with ${signal ?? code ?? "unknown status"}`,
            stdout,
            stderr,
          ));
        }
      });
    });
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    throw new Error("Claude CLI usage probe ended before rendering usage.");
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    if (usageOutputLooksRelevant(cleaned)) {
      throw new Error("Claude CLI usage probe ended before rendering usage.");
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function fetchClaudeCliQuota(env: NodeJS.ProcessEnv = process.env): Promise<QuotaWindow[]> {
  const rawText = await captureClaudeCliUsageText(12_000, env);
  return parseClaudeCliUsageText(rawText);
}

function formatProviderError(source: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${source}: ${message}`;
}

export async function getQuotaWindows(env: NodeJS.ProcessEnv = process.env): Promise<ProviderQuotaResult> {
  if (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyProcessEnv("ANTHROPIC_BEDROCK_BASE_URL", env)
  ) {
    return {
      provider: "anthropic",
      source: "bedrock",
      ok: true,
      windows: withClaudePrimaryQuotaWindows([]),
    };
  }

  const authStatus = await readClaudeAuthStatus(env);
  const authDescription = describeClaudeSubscriptionAuth(authStatus);
  const token = await readClaudeToken(env);

  const errors: string[] = [];

  if (token) {
    try {
      const windows = await fetchClaudeQuota(token);
      return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_OAUTH, ok: true, windows };
    } catch (error) {
      errors.push(formatProviderError("Anthropic OAuth usage", error));
    }
  }

  try {
    const windows = await fetchClaudeCliQuota(env);
    return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_CLI, ok: true, windows };
  } catch (error) {
    errors.push(formatProviderError("Claude CLI /usage", error));
  }

  if (hasNonEmptyProcessEnv("ANTHROPIC_API_KEY", env) && !authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error:
        errors[0]
        ?? "ANTHROPIC_API_KEY is set and no local Claude subscription session is available for quota polling",
      windows: [],
    };
  }

  if (authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error:
        errors.length > 0
          ? `${authDescription}, but quota polling failed (${errors.join("; ")})`
          : `${authDescription}, but Paperclip could not load subscription quota data`,
      windows: [],
    };
  }

  return {
    provider: "anthropic",
    ok: false,
    error: errors[0] ?? "no local claude auth token",
    windows: [],
  };
}
