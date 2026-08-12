import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, claudeAccounts, heartbeatRuns } from "@paperclipai/db";
import type {
  ClaudeAccountAssignment,
  ClaudeAccountLoginState,
  ClaudeAccountMode,
  ClaudeAccountQuota,
  ClaudeAccountsOverview,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { getQuotaWindows, readClaudeAuthStatus } from "@paperclipai/adapter-claude-local/server";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";

const LOGIN_LIFETIME_MS = 15 * 60 * 1000;
const ACCOUNT_HIGH_WATER_PERCENT = 95;
const ACTIVE_RUN_PRESSURE_PERCENT = 15;
const accountSelectionLocks = new Map<string, Promise<void>>();
const URL_RE = /https:\/\/[^\s\u001b]+/i;
const CLAUDE_SUBSCRIPTION_BLOCKING_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

interface LoginSession {
  accountId: string;
  companyId: string;
  process: ChildProcess;
  active: boolean;
  status: "waiting_for_user" | "authenticated" | "failed" | "expired";
  verificationUrl: string | null;
  startedAt: string;
  expiresAt: string;
  error: string | null;
  expiryTimer: NodeJS.Timeout;
}

interface SelectableClaudeAccount {
  id: string;
  companyId: string;
  name: string;
}

export interface FirstAvailableClaudeAccountSelection {
  accountId: string;
  accountName: string;
  claudeConfigDir: string;
  quotaState: "available" | "unknown" | "exhausted_fallback";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPlainEnvValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const record = asRecord(value);
  if (record?.type !== "plain") return null;
  return typeof record.value === "string" ? record.value.trim() || null : null;
}

function hasConfiguredProvider(adapterConfig: unknown): string | null {
  const env = asRecord(asRecord(adapterConfig)?.env);
  for (const key of CLAUDE_SUBSCRIPTION_BLOCKING_ENV_KEYS) {
    const value = env?.[key];
    const plainValue = readPlainEnvValue(value);
    const isProviderFlag = key === "CLAUDE_CODE_USE_BEDROCK" || key === "CLAUDE_CODE_USE_VERTEX";
    if (plainValue && (!isProviderFlag || ["1", "true", "yes"].includes(plainValue.toLowerCase()))) {
      return key;
    }
    const binding = asRecord(value);
    if (binding?.type === "secret_ref" && typeof binding.secretId === "string") return key;
  }
  return null;
}

function resolveClaudeExecutable(): string {
  return process.env.PAPERCLIP_CLAUDE_EXECUTABLE?.trim() || "claude";
}

export function resolveClaudeAccountConfigDir(companyId: string, accountId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: process.env.PAPERCLIP_HOME?.trim() || undefined,
    instanceId: process.env.PAPERCLIP_INSTANCE_ID?.trim() || undefined,
    env: process.env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "claude-accounts", accountId, "claude-config");
}

function accountEnv(companyId: string, accountId: string): NodeJS.ProcessEnv {
  const configDir = resolveClaudeAccountConfigDir(companyId, accountId);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
  };
  for (const key of CLAUDE_SUBSCRIPTION_BLOCKING_ENV_KEYS) delete env[key];
  return env;
}

async function hasUsableAuth(companyId: string, accountId: string): Promise<boolean> {
  const status = await readClaudeAuthStatus(accountEnv(companyId, accountId));
  return status?.loggedIn === true && status.authMethod === "claude.ai";
}

function publicLoginState(session: LoginSession | undefined): ClaudeAccountLoginState {
  if (!session) {
    return {
      status: "idle",
      verificationUrl: null,
      startedAt: null,
      expiresAt: null,
      error: null,
    };
  }
  return {
    status: session.status,
    verificationUrl: session.verificationUrl,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    error: session.error,
  };
}

function normalizeClaudeAccountMode(value: string): ClaudeAccountMode {
  return value === "fixed" || value === "first_available" ? value : "host";
}

export function claudeAccountIdFromRunContext(value: unknown): string | null {
  let snapshot = value;
  if (typeof snapshot === "string") {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return null;
    }
  }
  const account = asRecord(asRecord(snapshot)?.paperclipClaudeAccount);
  return typeof account?.accountId === "string" && account.accountId.trim()
    ? account.accountId.trim()
    : null;
}

export async function withClaudeAccountSelectionLock<T>(
  companyId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = accountSelectionLocks.get(companyId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  accountSelectionLocks.set(companyId, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (accountSelectionLocks.get(companyId) === tail) accountSelectionLocks.delete(companyId);
  }
}

export async function selectFirstAvailableClaudeAccount(input: {
  accounts: SelectableClaudeAccount[];
  busyAccountIds?: Iterable<string>;
  readAuthStatus?: typeof readClaudeAuthStatus;
  readQuota?: typeof getQuotaWindows;
}): Promise<FirstAvailableClaudeAccountSelection | null> {
  const readAuthStatus = input.readAuthStatus ?? readClaudeAuthStatus;
  const readQuota = input.readQuota ?? getQuotaWindows;
  const busy = new Map<string, number>();
  for (const id of input.busyAccountIds ?? []) busy.set(id, (busy.get(id) ?? 0) + 1);
  const candidates: Array<FirstAvailableClaudeAccountSelection & {
    activeRuns: number;
    usedPercent: number | null;
  }> = [];

  for (const account of input.accounts) {
    const env = accountEnv(account.companyId, account.id);
    const auth = await readAuthStatus(env);
    if (!auth?.loggedIn || auth.authMethod !== "claude.ai") continue;
    const quota = await readQuota(env);
    const reported = quota.ok
      ? quota.windows.map((window) => window.usedPercent)
          .filter((value): value is number => value != null && Number.isFinite(value))
      : [];
    const usedPercent = reported.length ? Math.max(...reported) : null;
    const quotaState = !quota.ok || usedPercent == null
      ? "unknown" as const
      : usedPercent >= ACCOUNT_HIGH_WATER_PERCENT
        ? "exhausted_fallback" as const
        : "available" as const;
    candidates.push({
      accountId: account.id,
      accountName: account.name,
      claudeConfigDir: resolveClaudeAccountConfigDir(account.companyId, account.id),
      quotaState,
      activeRuns: busy.get(account.id) ?? 0,
      usedPercent,
    });
  }

  const rank = { available: 0, unknown: 1, exhausted_fallback: 2 } as const;
  candidates.sort((left, right) => {
    const rankDelta = rank[left.quotaState] - rank[right.quotaState];
    if (rankDelta) return rankDelta;
    const leftPressure = (left.usedPercent ?? 100) + left.activeRuns * ACTIVE_RUN_PRESSURE_PERCENT;
    const rightPressure = (right.usedPercent ?? 100) + right.activeRuns * ACTIVE_RUN_PRESSURE_PERCENT;
    if (leftPressure !== rightPressure) return leftPressure - rightPressure;
    return left.activeRuns - right.activeRuns;
  });
  const selected = candidates[0];
  return selected ? {
    accountId: selected.accountId,
    accountName: selected.accountName,
    claudeConfigDir: selected.claudeConfigDir,
    quotaState: selected.quotaState,
  } : null;
}

export async function resolveFirstAvailableClaudeAccount(
  db: Db,
  companyId: string,
): Promise<FirstAvailableClaudeAccountSelection | null> {
  const [accountRows, busyRows] = await Promise.all([
    db.select({ id: claudeAccounts.id, companyId: claudeAccounts.companyId, name: claudeAccounts.name })
      .from(claudeAccounts)
      .where(eq(claudeAccounts.companyId, companyId))
      .orderBy(asc(claudeAccounts.createdAt)),
    db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"]))),
  ]);
  return selectFirstAvailableClaudeAccount({
    accounts: accountRows,
    busyAccountIds: busyRows.flatMap((row) => {
      const id = claudeAccountIdFromRunContext(row.contextSnapshot);
      return id ? [id] : [];
    }),
  });
}

async function loadQuota(env: NodeJS.ProcessEnv, authenticated: boolean): Promise<ClaudeAccountQuota> {
  if (!authenticated) return { status: "unauthenticated", windows: [], fetchedAt: null, error: null };
  const fetchedAt = new Date().toISOString();
  const result = await getQuotaWindows(env);
  if (!result.ok) {
    return { status: "unknown", windows: [], fetchedAt, error: result.error ?? "Usage is unavailable." };
  }
  return {
    status: result.windows.some((window) => window.usedPercent != null && window.usedPercent >= 100)
      ? "exhausted"
      : result.windows.length ? "available" : "unknown",
    windows: result.windows.map((window) => ({ ...window, detail: window.detail ?? null })),
    fetchedAt,
    error: result.windows.length ? null : "Anthropic did not report usage windows for this account.",
  };
}

export function claudeAccountService(db: Db) {
  const loginSessions = new Map<string, LoginSession>();
  const agentsSvc = agentService(db);

  async function requireAccount(companyId: string, accountId: string) {
    const account = await db.select().from(claudeAccounts)
      .where(and(eq(claudeAccounts.companyId, companyId), eq(claudeAccounts.id, accountId)))
      .then((rows) => rows[0] ?? null);
    if (!account) throw notFound("Claude account not found");
    return account;
  }

  function terminate(session: LoginSession) {
    session.process.kill("SIGTERM");
  }

  return {
    list: async (companyId: string): Promise<ClaudeAccountsOverview> => {
      const [accountRows, agentRows] = await Promise.all([
        db.select().from(claudeAccounts).where(eq(claudeAccounts.companyId, companyId))
          .orderBy(asc(claudeAccounts.createdAt)),
        db.select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
          claudeAccountMode: agents.claudeAccountMode,
          claudeAccountId: agents.claudeAccountId,
          adapterConfig: agents.adapterConfig,
        }).from(agents).where(and(
          eq(agents.companyId, companyId),
          eq(agents.adapterType, "claude_local"),
          ne(agents.status, "terminated"),
        )).orderBy(asc(agents.name)),
      ]);

      const accounts = await Promise.all(accountRows.map(async (account) => {
        const env = accountEnv(companyId, account.id);
        const auth = await readClaudeAuthStatus(env);
        const authenticated = auth?.loggedIn === true && auth.authMethod === "claude.ai";
        const login = publicLoginState(loginSessions.get(account.id));
        if (authenticated && login.status === "idle") login.status = "authenticated";
        return {
          id: account.id,
          companyId: account.companyId,
          name: account.name,
          authenticated,
          authMethod: auth?.authMethod ?? null,
          planType: auth?.subscriptionType ?? null,
          lastAuthenticatedAt: account.lastAuthenticatedAt?.toISOString() ?? null,
          assignedAgentIds: agentRows.filter((agent) => agent.claudeAccountId === account.id).map((agent) => agent.id),
          quota: await loadQuota(env, authenticated),
          login,
          createdAt: account.createdAt.toISOString(),
          updatedAt: account.updatedAt.toISOString(),
        };
      }));

      return {
        accounts,
        agents: agentRows.map((agent) => {
          const blocker = hasConfiguredProvider(agent.adapterConfig);
          return {
            id: agent.id,
            name: agent.name,
            status: agent.status as ClaudeAccountsOverview["agents"][number]["status"],
            claudeAccountMode: normalizeClaudeAccountMode(agent.claudeAccountMode),
            claudeAccountId: agent.claudeAccountId,
            canUseSubscriptionAccount: blocker == null,
            subscriptionAccountBlocker: blocker
              ? `This agent is configured with ${blocker}. Remove that binding before assigning a Claude subscription account.`
              : null,
          };
        }),
      };
    },

    create: async (companyId: string, name: string) => {
      const id = randomUUID();
      const configDir = resolveClaudeAccountConfigDir(companyId, id);
      await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
      try {
        return await db.insert(claudeAccounts).values({ id, companyId, name: name.trim() })
          .returning().then((rows) => rows[0]!);
      } catch (error) {
        await fs.rm(path.dirname(configDir), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },

    startLogin: async (companyId: string, accountId: string): Promise<ClaudeAccountLoginState> => {
      await requireAccount(companyId, accountId);
      const current = loginSessions.get(accountId);
      if (current?.active) return publicLoginState(current);
      const configDir = resolveClaudeAccountConfigDir(companyId, accountId);
      await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + LOGIN_LIFETIME_MS);
      const child = spawn(resolveClaudeExecutable(), ["auth", "login", "--claudeai"], {
        env: accountEnv(companyId, accountId),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: false,
      });
      const session: LoginSession = {
        accountId,
        companyId,
        process: child,
        active: true,
        status: "waiting_for_user",
        verificationUrl: null,
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        error: null,
        expiryTimer: setTimeout(() => undefined, LOGIN_LIFETIME_MS),
      };
      clearTimeout(session.expiryTimer);
      session.expiryTimer = setTimeout(() => {
        if (!session.active) return;
        session.active = false;
        session.status = "expired";
        session.error = "Claude login expired. Start a new login to continue.";
        terminate(session);
      }, LOGIN_LIFETIME_MS);
      session.expiryTimer.unref();
      loginSessions.set(accountId, session);

      const capture = (chunk: Buffer | string) => {
        const url = String(chunk).match(URL_RE)?.[0];
        if (url) session.verificationUrl = url;
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", () => {
        if (!session.active) return;
        session.active = false;
        clearTimeout(session.expiryTimer);
        session.status = "failed";
        session.error = `Could not start ${resolveClaudeExecutable()}. Ensure the Claude CLI is installed and available to Paperclip.`;
      });
      child.once("close", (exitCode) => {
        void (async () => {
          if (!session.active) return;
          session.active = false;
          clearTimeout(session.expiryTimer);
          if (exitCode === 0 && await hasUsableAuth(companyId, accountId)) {
            session.status = "authenticated";
            session.error = null;
            await db.update(claudeAccounts).set({ lastAuthenticatedAt: new Date(), updatedAt: new Date() })
              .where(eq(claudeAccounts.id, accountId));
          } else {
            session.status = "failed";
            session.error = "Claude did not complete authentication. Start a new login and try again.";
          }
        })().catch(() => {
          session.active = false;
          session.status = "failed";
          session.error = "Paperclip could not verify the completed Claude login.";
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return publicLoginState(session);
    },

    assignAgent: async (
      companyId: string,
      agentId: string,
      assignment: ClaudeAccountAssignment,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const agent = await agentsSvc.getById(agentId);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
      if (agent.adapterType !== "claude_local") {
        throw unprocessable("Only Claude agents can be assigned to a Claude account");
      }
      const blocker = hasConfiguredProvider(agent.adapterConfig);
      if (blocker) throw conflict(`Remove ${blocker} from this agent before assigning a Claude subscription account`);

      const adapterConfig = { ...agent.adapterConfig };
      const env = { ...(asRecord(adapterConfig.env) ?? {}) };
      if (agent.claudeAccountId) {
        const oldDir = resolveClaudeAccountConfigDir(companyId, agent.claudeAccountId);
        if (readPlainEnvValue(env.CLAUDE_CONFIG_DIR) === oldDir) delete env.CLAUDE_CONFIG_DIR;
        if (readPlainEnvValue(env.CLAUDE_SECURESTORAGE_CONFIG_DIR) === oldDir) delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      }
      for (const key of CLAUDE_SUBSCRIPTION_BLOCKING_ENV_KEYS) {
        if (env[key] === "") delete env[key];
      }
      const accountId = assignment.mode === "fixed" ? assignment.accountId : null;
      if (assignment.mode === "fixed") {
        if (!accountId) throw unprocessable("A fixed Claude account requires an account identifier");
        await requireAccount(companyId, accountId);
        if (!(await hasUsableAuth(companyId, accountId))) {
          throw conflict("Authenticate this Claude account before assigning agents to it");
        }
        const configDir = resolveClaudeAccountConfigDir(companyId, accountId);
        env.CLAUDE_CONFIG_DIR = configDir;
        env.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir;
      } else if (assignment.mode === "first_available") {
        const rows = await db.select({ id: claudeAccounts.id }).from(claudeAccounts)
          .where(eq(claudeAccounts.companyId, companyId));
        let authenticated = false;
        for (const row of rows) {
          if (await hasUsableAuth(companyId, row.id)) { authenticated = true; break; }
        }
        if (!authenticated) throw conflict("Authenticate at least one Claude account before enabling automatic selection");
      }
      if (assignment.mode !== "host") {
        for (const key of CLAUDE_SUBSCRIPTION_BLOCKING_ENV_KEYS) env[key] = "";
      }
      adapterConfig.env = env;
      const updated = await agentsSvc.update(agentId, {
        claudeAccountMode: assignment.mode,
        claudeAccountId: accountId,
        adapterConfig,
      }, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "claude_account_assignment",
        },
      });
      if (!updated) throw notFound("Agent not found");
      return updated;
    },

    remove: async (companyId: string, accountId: string) => {
      await requireAccount(companyId, accountId);
      const assigned = await db.select({ id: agents.id }).from(agents).where(eq(agents.claudeAccountId, accountId));
      if (assigned.length) throw conflict("Unassign all agents before removing this Claude account");
      const session = loginSessions.get(accountId);
      if (session?.active) terminate(session);
      loginSessions.delete(accountId);
      await fs.rm(path.dirname(resolveClaudeAccountConfigDir(companyId, accountId)), { recursive: true, force: true });
      await db.delete(claudeAccounts)
        .where(and(eq(claudeAccounts.companyId, companyId), eq(claudeAccounts.id, accountId)));
    },
  };
}
