import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, codexAccounts, heartbeatRuns } from "@paperclipai/db";
import type {
  CodexAccountAssignment,
  CodexAccountLoginState,
  CodexAccountMode,
  CodexAccountQuota,
  CodexAccountQuotaWindow,
  CodexAccountsOverview,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import {
  codexHomeHasUsableAuth,
  fetchCodexQuota,
  readCodexAuthInfo,
} from "@paperclipai/adapter-codex-local/server";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";

const LOGIN_LIFETIME_MS = 15 * 60 * 1000;
const LOGIN_PROMPT_WAIT_MS = 15_000;
const LOGIN_OUTPUT_LIMIT = 16_000;
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
const DEVICE_URL_RE = /https:\/\/[^\s]+\/codex\/device/i;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/i;
const accountSelectionLocks = new Map<string, Promise<void>>();

export interface CodexLoginCommand {
  command: string;
  args: string[];
  detached: boolean;
}

type InternalLoginStatus = "waiting_for_user" | "authenticated" | "failed" | "expired";

interface LoginSession {
  accountId: string;
  companyId: string;
  process: ChildProcess;
  active: boolean;
  status: InternalLoginStatus;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: string;
  expiresAt: string;
  error: string | null;
  output: string;
  promptWaiters: Set<() => void>;
  expiryTimer: NodeJS.Timeout;
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

function hasConfiguredApiKey(adapterConfig: unknown): boolean {
  const env = asRecord(asRecord(adapterConfig)?.env);
  const value = env?.OPENAI_API_KEY;
  if (readPlainEnvValue(value)) return true;
  const binding = asRecord(value);
  return binding?.type === "secret_ref" && typeof binding.secretId === "string";
}

function publicLoginState(session: LoginSession | undefined): CodexAccountLoginState {
  if (!session) {
    return {
      status: "idle",
      verificationUrl: null,
      userCode: null,
      startedAt: null,
      expiresAt: null,
      error: null,
    };
  }
  return {
    status: session.status,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    error: session.error,
  };
}

function resolveCodexExecutable(): string {
  const configured = process.env.PAPERCLIP_CODEX_EXECUTABLE?.trim();
  return configured || "codex";
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveCodexLoginCommand(
  executable: string = resolveCodexExecutable(),
  platform: NodeJS.Platform = process.platform,
): CodexLoginCommand {
  // Codex intentionally writes the device URL and one-time code only when it
  // has a terminal. Paperclip normally runs as a background service, so give
  // the login subprocess a pseudo-terminal via the platform's `script` tool.
  if (platform === "darwin") {
    return {
      command: "/usr/bin/script",
      args: ["-q", "/dev/null", executable, "login", "--device-auth"],
      detached: true,
    };
  }
  if (platform === "linux") {
    return {
      command: "/usr/bin/script",
      args: [
        "-q",
        "-e",
        "-c",
        `${quotePosixShellArg(executable)} login --device-auth`,
        "/dev/null",
      ],
      detached: true,
    };
  }
  return {
    command: executable,
    args: ["login", "--device-auth"],
    detached: false,
  };
}

export function parseCodexDevicePrompt(output: string): {
  verificationUrl: string | null;
  userCode: string | null;
} {
  const cleaned = output.replace(ANSI_ESCAPE_RE, "");
  return {
    verificationUrl: cleaned.match(DEVICE_URL_RE)?.[0] ?? null,
    userCode: cleaned.match(DEVICE_CODE_RE)?.[0]?.toUpperCase() ?? null,
  };
}

export function resolveCodexAccountHome(companyId: string, accountId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: process.env.PAPERCLIP_HOME?.trim() || undefined,
    instanceId: process.env.PAPERCLIP_INSTANCE_ID?.trim() || undefined,
    env: process.env,
  });
  return path.resolve(
    instanceRoot,
    "companies",
    companyId,
    "codex-accounts",
    accountId,
    "codex-home",
  );
}

interface AutoSelectableCodexAccount {
  id: string;
  companyId: string;
  name: string;
}

export interface FirstAvailableCodexAccountSelection {
  accountId: string;
  accountName: string;
  codexHome: string;
  quotaState: "available" | "unknown" | "exhausted_fallback";
}

export async function withCodexAccountSelectionLock<T>(
  companyId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = accountSelectionLocks.get(companyId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  accountSelectionLocks.set(companyId, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (accountSelectionLocks.get(companyId) === tail) {
      accountSelectionLocks.delete(companyId);
    }
  }
}

export async function selectFirstAvailableCodexAccount(input: {
  accounts: AutoSelectableCodexAccount[];
  busyAccountIds?: Iterable<string>;
  readAuthInfo?: typeof readCodexAuthInfo;
  fetchQuota?: typeof fetchCodexQuota;
}): Promise<FirstAvailableCodexAccountSelection | null> {
  const readAuthInfo = input.readAuthInfo ?? readCodexAuthInfo;
  const fetchQuota = input.fetchQuota ?? fetchCodexQuota;
  const busyAccountIds = new Set(input.busyAccountIds ?? []);
  const selections: Array<FirstAvailableCodexAccountSelection & { busy: boolean }> = [];

  for (const account of input.accounts) {
    const codexHome = resolveCodexAccountHome(account.companyId, account.id);
    const auth = await readAuthInfo(codexHome);
    if (!auth) continue;

    try {
      const windows = await fetchQuota(auth.accessToken, auth.accountId);
      const exhausted = windows.some(
        (window) => window.usedPercent != null && window.usedPercent >= 100,
      );
      selections.push({
        accountId: account.id,
        accountName: account.name,
        codexHome,
        quotaState: exhausted ? "exhausted_fallback" : "available",
        busy: busyAccountIds.has(account.id),
      });
    } catch {
      selections.push({
        accountId: account.id,
        accountName: account.name,
        codexHome,
        quotaState: "unknown",
        busy: busyAccountIds.has(account.id),
      });
    }
  }

  // Prefer a profile that both has quota and is not already running another
  // heartbeat. This turns "first available" into an actual shared pool: two
  // concurrently active agents no longer pile onto the first authenticated
  // account while another account sits idle. Busy accounts remain fallbacks so
  // a company with fewer accounts than workers can still make progress.
  const preference: Array<[FirstAvailableCodexAccountSelection["quotaState"], boolean]> = [
    ["available", false],
    ["unknown", false],
    ["available", true],
    ["unknown", true],
    ["exhausted_fallback", false],
    ["exhausted_fallback", true],
  ];
  for (const [quotaState, busy] of preference) {
    const selection = selections.find(
      (candidate) => candidate.quotaState === quotaState && candidate.busy === busy,
    );
    if (selection) {
      return {
        accountId: selection.accountId,
        accountName: selection.accountName,
        codexHome: selection.codexHome,
        quotaState: selection.quotaState,
      };
    }
  }
  return null;
}

export async function resolveFirstAvailableCodexAccount(
  db: Db,
  companyId: string,
): Promise<FirstAvailableCodexAccountSelection | null> {
  const [accountRows, busyRows] = await Promise.all([
    db
      .select({
        id: codexAccounts.id,
        companyId: codexAccounts.companyId,
        name: codexAccounts.name,
      })
      .from(codexAccounts)
      .where(eq(codexAccounts.companyId, companyId))
      .orderBy(asc(codexAccounts.createdAt)),
    db
      .select({
        accountId: sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'paperclipCodexAccount' ->> 'accountId'`,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${heartbeatRuns.contextSnapshot} -> 'paperclipCodexAccount' ->> 'accountId' is not null`,
      )),
  ]);
  return selectFirstAvailableCodexAccount({
    accounts: accountRows,
    busyAccountIds: busyRows.flatMap((row) => row.accountId ? [row.accountId] : []),
  });
}

type CodexQuotaFetcher = (
  token: string,
  accountId: string | null,
) => Promise<CodexAccountQuotaWindow[]>;

export async function loadCodexAccountQuota(input: {
  accessToken: string | null;
  providerAccountId: string | null;
  fetchQuota?: CodexQuotaFetcher;
  now?: () => Date;
}): Promise<CodexAccountQuota> {
  if (!input.accessToken) {
    return {
      status: "unauthenticated",
      windows: [],
      fetchedAt: null,
      error: null,
    };
  }

  const fetchedAt = (input.now ?? (() => new Date()))().toISOString();
  try {
    const windows = await (input.fetchQuota ?? fetchCodexQuota)(
      input.accessToken,
      input.providerAccountId,
    );
    if (windows.length === 0) {
      return {
        status: "unknown",
        windows: [],
        fetchedAt,
        error: "OpenAI did not report usage windows for this account.",
      };
    }
    return {
      status: windows.some(
        (window) => window.usedPercent != null && window.usedPercent >= 100,
      )
        ? "exhausted"
        : "available",
      windows: windows.map((window) => ({
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        valueLabel: window.valueLabel,
        detail: window.detail ?? null,
      })),
      fetchedAt,
      error: null,
    };
  } catch {
    return {
      status: "unknown",
      windows: [],
      fetchedAt,
      error: "Usage data is temporarily unavailable. Paperclip will try again automatically.",
    };
  }
}

function normalizeCodexAccountMode(value: string): CodexAccountMode {
  return value === "fixed" || value === "first_available" ? value : "host";
}

export function codexAccountService(db: Db) {
  const loginSessions = new Map<string, LoginSession>();
  const agentsSvc = agentService(db);

  async function requireAccount(companyId: string, accountId: string) {
    const account = await db
      .select()
      .from(codexAccounts)
      .where(and(eq(codexAccounts.companyId, companyId), eq(codexAccounts.id, accountId)))
      .then((rows) => rows[0] ?? null);
    if (!account) throw notFound("Codex account not found");
    return account;
  }

  function notifyPromptWaiters(session: LoginSession) {
    for (const resolve of session.promptWaiters) resolve();
    session.promptWaiters.clear();
  }

  function parseLoginOutput(session: LoginSession, chunk: Buffer | string) {
    session.output = `${session.output}${String(chunk)}`
      .replace(ANSI_ESCAPE_RE, "")
      .slice(-LOGIN_OUTPUT_LIMIT);
    const prompt = parseCodexDevicePrompt(session.output);
    session.verificationUrl = prompt.verificationUrl ?? session.verificationUrl;
    session.userCode = prompt.userCode ?? session.userCode;
    if (session.verificationUrl && session.userCode) notifyPromptWaiters(session);
  }

  function terminateLoginProcess(
    session: LoginSession,
    signal: NodeJS.Signals = "SIGTERM",
  ) {
    const pid = session.process.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // The wrapper may have exited before its child. Fall back to the
        // regular ChildProcess kill path below.
      }
    }
    session.process.kill(signal);
  }

  async function finishLogin(session: LoginSession, exitCode: number | null) {
    if (!session.active) return;
    session.active = false;
    clearTimeout(session.expiryTimer);
    const authenticated = exitCode === 0 && await codexHomeHasUsableAuth(
      resolveCodexAccountHome(session.companyId, session.accountId),
    );
    if (authenticated) {
      session.status = "authenticated";
      session.error = null;
      await db
        .update(codexAccounts)
        .set({ lastAuthenticatedAt: new Date(), updatedAt: new Date() })
        .where(eq(codexAccounts.id, session.accountId));
    } else if (session.status !== "expired" && session.status !== "failed") {
      session.status = "failed";
      session.error = exitCode === null
        ? "Codex login ended before authentication completed."
        : "Codex did not complete authentication. Start a new login and try again.";
    }
    session.output = "";
    notifyPromptWaiters(session);
  }

  async function waitForLoginPrompt(session: LoginSession) {
    if (session.verificationUrl && session.userCode) return;
    if (!session.active || session.status !== "waiting_for_user") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.promptWaiters.delete(done);
        resolve();
      }, LOGIN_PROMPT_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      session.promptWaiters.add(done);
    });
  }

  return {
    list: async (companyId: string): Promise<CodexAccountsOverview> => {
      const [accountRows, agentRows] = await Promise.all([
        db
          .select()
          .from(codexAccounts)
          .where(eq(codexAccounts.companyId, companyId))
          .orderBy(asc(codexAccounts.createdAt)),
        db
          .select({
            id: agents.id,
            name: agents.name,
            status: agents.status,
            codexAccountMode: agents.codexAccountMode,
            codexAccountId: agents.codexAccountId,
            adapterConfig: agents.adapterConfig,
          })
          .from(agents)
          .where(and(
            eq(agents.companyId, companyId),
            eq(agents.adapterType, "codex_local"),
            ne(agents.status, "terminated"),
          ))
          .orderBy(asc(agents.name)),
      ]);

      const accountSummaries = await Promise.all(accountRows.map(async (account) => {
        const auth = await readCodexAuthInfo(resolveCodexAccountHome(companyId, account.id));
        const quota = await loadCodexAccountQuota({
          accessToken: auth?.accessToken ?? null,
          providerAccountId: auth?.accountId ?? null,
        });
        const loginSession = loginSessions.get(account.id);
        const login = publicLoginState(loginSession);
        if (auth && login.status === "idle") login.status = "authenticated";
        return {
          id: account.id,
          companyId: account.companyId,
          name: account.name,
          authenticated: auth != null,
          email: auth?.email ?? null,
          planType: auth?.planType ?? null,
          lastRefresh: auth?.lastRefresh ?? null,
          lastAuthenticatedAt: account.lastAuthenticatedAt?.toISOString() ?? null,
          assignedAgentIds: agentRows
            .filter((agent) => agent.codexAccountId === account.id)
            .map((agent) => agent.id),
          quota,
          login,
          createdAt: account.createdAt.toISOString(),
          updatedAt: account.updatedAt.toISOString(),
        };
      }));

      return {
        accounts: accountSummaries,
        agents: agentRows.map((agent) => {
          const apiKeyConfigured = hasConfiguredApiKey(agent.adapterConfig);
          return {
            id: agent.id,
            name: agent.name,
            status: agent.status as CodexAccountsOverview["agents"][number]["status"],
            codexAccountMode: normalizeCodexAccountMode(agent.codexAccountMode),
            codexAccountId: agent.codexAccountId,
            canUseSubscriptionAccount: !apiKeyConfigured,
            subscriptionAccountBlocker: apiKeyConfigured
              ? "This agent is configured with OPENAI_API_KEY. Remove that binding before assigning a ChatGPT account."
              : null,
          };
        }),
      };
    },

    create: async (companyId: string, name: string) => {
      const id = randomUUID();
      const home = resolveCodexAccountHome(companyId, id);
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      try {
        return await db
          .insert(codexAccounts)
          .values({ id, companyId, name: name.trim() })
          .returning()
          .then((rows) => rows[0]!);
      } catch (error) {
        await fs.rm(path.dirname(home), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },

    startLogin: async (companyId: string, accountId: string): Promise<CodexAccountLoginState> => {
      await requireAccount(companyId, accountId);
      const current = loginSessions.get(accountId);
      if (current?.active) return publicLoginState(current);

      const home = resolveCodexAccountHome(companyId, accountId);
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + LOGIN_LIFETIME_MS);
      const loginCommand = resolveCodexLoginCommand();
      const child = spawn(loginCommand.command, loginCommand.args, {
        env: { ...process.env, CODEX_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: loginCommand.detached,
      });
      const session: LoginSession = {
        accountId,
        companyId,
        process: child,
        active: true,
        status: "waiting_for_user",
        verificationUrl: null,
        userCode: null,
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        error: null,
        output: "",
        promptWaiters: new Set<() => void>(),
        expiryTimer: setTimeout(() => undefined, LOGIN_LIFETIME_MS),
      };
      clearTimeout(session.expiryTimer);
      session.expiryTimer = setTimeout(() => {
        if (!session.active) return;
        session.status = "expired";
        session.error = "The device code expired. Start a new login to continue.";
        terminateLoginProcess(session);
        notifyPromptWaiters(session);
      }, LOGIN_LIFETIME_MS);
      session.expiryTimer.unref();
      loginSessions.set(accountId, session);

      child.stdout.on("data", (chunk) => parseLoginOutput(session, chunk));
      child.stderr.on("data", (chunk) => parseLoginOutput(session, chunk));
      child.once("error", () => {
        if (!session.active) return;
        session.active = false;
        clearTimeout(session.expiryTimer);
        session.status = "failed";
        session.error = `Could not start ${resolveCodexExecutable()}. Ensure the Codex CLI is installed and available to Paperclip.`;
        session.output = "";
        notifyPromptWaiters(session);
      });
      child.once("close", (exitCode) => {
        void finishLogin(session, exitCode).catch(() => {
          session.active = false;
          session.status = "failed";
          session.error = "Paperclip could not verify the completed Codex login.";
          session.output = "";
          notifyPromptWaiters(session);
        });
      });

      await waitForLoginPrompt(session);
      if (
        session.active
        && session.status === "waiting_for_user"
        && (!session.verificationUrl || !session.userCode)
      ) {
        session.active = false;
        clearTimeout(session.expiryTimer);
        session.status = "failed";
        session.error = "Codex did not provide a device login code. Verify that device-code authentication is enabled, then try again.";
        session.output = "";
        terminateLoginProcess(session);
        notifyPromptWaiters(session);
      }
      return publicLoginState(session);
    },

    assignAgent: async (
      companyId: string,
      agentId: string,
      assignment: CodexAccountAssignment,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const agent = await agentsSvc.getById(agentId);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
      if (agent.adapterType !== "codex_local") {
        throw unprocessable("Only Codex agents can be assigned to a Codex account");
      }
      if (hasConfiguredApiKey(agent.adapterConfig)) {
        throw conflict("Remove OPENAI_API_KEY from this agent before assigning a ChatGPT account");
      }

      const adapterConfig = { ...agent.adapterConfig };
      const env = { ...(asRecord(adapterConfig.env) ?? {}) };
      if (agent.codexAccountId) {
        const assignedHome = resolveCodexAccountHome(companyId, agent.codexAccountId);
        if (readPlainEnvValue(env.CODEX_HOME) === assignedHome) delete env.CODEX_HOME;
      }

      const accountId = assignment.mode === "fixed" ? assignment.accountId : null;
      if (assignment.mode === "fixed") {
        if (!accountId) throw unprocessable("A fixed Codex account requires an account identifier");
        await requireAccount(companyId, accountId);
        const home = resolveCodexAccountHome(companyId, accountId);
        if (!(await codexHomeHasUsableAuth(home))) {
          throw conflict("Authenticate this Codex account before assigning agents to it");
        }
        env.CODEX_HOME = home;
      } else if (assignment.mode === "first_available") {
        const accountRows = await db
          .select({ id: codexAccounts.id })
          .from(codexAccounts)
          .where(eq(codexAccounts.companyId, companyId))
          .orderBy(asc(codexAccounts.createdAt));
        let hasAuthenticatedAccount = false;
        for (const account of accountRows) {
          if (await codexHomeHasUsableAuth(resolveCodexAccountHome(companyId, account.id))) {
            hasAuthenticatedAccount = true;
            break;
          }
        }
        if (!hasAuthenticatedAccount) {
          throw conflict("Authenticate at least one Codex account before enabling automatic selection");
        }
      }
      adapterConfig.env = env;

      const updated = await agentsSvc.update(
        agentId,
        {
          codexAccountMode: assignment.mode,
          codexAccountId: accountId,
          adapterConfig,
        },
        {
          recordRevision: {
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            source: "codex_account_assignment",
          },
        },
      );
      if (!updated) throw notFound("Agent not found");
      return updated;
    },

    remove: async (companyId: string, accountId: string) => {
      await requireAccount(companyId, accountId);
      const assigned = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.codexAccountId, accountId));
      if (assigned.length > 0) {
        throw conflict("Unassign all agents before removing this Codex account");
      }
      const session = loginSessions.get(accountId);
      if (session?.active) terminateLoginProcess(session);
      loginSessions.delete(accountId);
      await fs.rm(path.dirname(resolveCodexAccountHome(companyId, accountId)), {
        recursive: true,
        force: true,
      });
      await db
        .delete(codexAccounts)
        .where(and(eq(codexAccounts.companyId, companyId), eq(codexAccounts.id, accountId)));
    },
  };
}
