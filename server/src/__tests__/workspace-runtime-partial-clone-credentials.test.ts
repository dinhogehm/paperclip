import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensurePersistedExecutionWorkspaceAvailable,
  realizeExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { GIT_CREDENTIAL_TOKEN_ENV_KEY } from "../services/git-credentials.ts";

/**
 * Credentials for checkout-shaped git operations in a partial clone (NUR-281).
 *
 * `worktree add`, `reset --hard`, and `checkout` look purely local, but in a partial clone they
 * are not: materializing a working tree fetches the missing blobs from the promisor remote.
 * Without a credential that fetch reaches the interactive prompt, and preparing a workspace for
 * a private repository dies mid-checkout with
 * `could not read Username for 'https://github.com': No such device or address` /
 * `could not fetch <oid> from promisor remote` — the failures that blocked most of the board.
 *
 * These tests are hermetic — no network. A local bare repository stands in for the remote, and
 * the promisor URL is made unreachable so the lazy fetch fails exactly as an unauthenticated one
 * does. The fake provider's `configArgs` carry an `insteadOf` rewrite back to the real bare
 * repository, so "the credential worked" is observable as the operation succeeding, in the same
 * place a real token would take effect. Env delivery is observed through a `post-checkout` hook,
 * which git runs as a child of the very process under test.
 */

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

type PartialCloneFixture = {
  repoRoot: string;
  seed: string;
  /** The bare repository that actually holds the objects. */
  realRemotePath: string;
  /** The path `origin` points at; renamed away by `breakPromisor`. */
  promisorPath: string;
  worktreeParentDir: string;
};

/** A partial clone (`--filter=blob:none`) of a local bare repository, promisor intact. */
async function createPartialClone(): Promise<PartialCloneFixture> {
  const root = await makeTempDir("paperclip-partial-clone-");
  const seed = path.join(root, "seed");
  const promisorPath = path.join(root, "remote.git");

  await execFileAsync("git", ["init", "--bare", "--initial-branch=master", promisorPath]);
  // A partial clone is only possible when the serving side allows filtering.
  await git(promisorPath, ["config", "uploadpack.allowfilter", "true"]);
  await git(promisorPath, ["config", "uploadpack.allowanysha1inwant", "true"]);

  await fs.mkdir(seed, { recursive: true });
  await git(seed, ["init", "--initial-branch=master"]);
  await git(seed, ["config", "user.email", "paperclip@example.com"]);
  await git(seed, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(seed, "first.txt"), "first\n", "utf8");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "first"]);
  await git(seed, ["push", promisorPath, "master"]);

  const repoRoot = path.join(root, "clone");
  await execFileAsync("git", ["clone", "--filter=blob:none", `file://${promisorPath}`, repoRoot]);
  await git(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);

  return {
    repoRoot,
    seed,
    realRemotePath: path.join(root, "remote-real.git"),
    promisorPath,
    worktreeParentDir: path.join(root, "worktrees"),
  };
}

/**
 * Push a commit whose blob the clone never received. Under `blob:none` the follow-up fetch
 * brings the ref but not the blob, so materializing it later must go back to the promisor.
 */
async function addRemoteCommitWithLazyBlob(fixture: PartialCloneFixture, fileName: string) {
  await fs.writeFile(path.join(fixture.seed, fileName), `${fileName} ${"x".repeat(512)}\n`, "utf8");
  await git(fixture.seed, ["add", "-A"]);
  await git(fixture.seed, ["commit", "-m", `add ${fileName}`]);
  await git(fixture.seed, ["push", fixture.promisorPath, "master"]);
  await git(fixture.repoRoot, ["fetch", "origin"]);

  const missing = await git(fixture.repoRoot, ["rev-list", "--objects", "--all", "--missing=print"]);
  expect(missing).toContain("?");
  return fileName;
}

/** Make the promisor remote unreachable, as an unauthenticated private fetch effectively is. */
async function breakPromisor(fixture: PartialCloneFixture) {
  await fs.rename(fixture.promisorPath, fixture.realRemotePath);
}

/** A provider whose `configArgs`/`env` stand in for a working GitHub credential. */
function fakeCredentialProvider(fixture: PartialCloneFixture, extraConfigArgs: string[] = []) {
  return vi.fn(async (_remoteUrl: string) => ({
    configArgs: [
      "-c",
      `url.file://${fixture.realRemotePath}.insteadOf=file://${fixture.promisorPath}`,
      ...extraConfigArgs,
    ],
    env: { [GIT_CREDENTIAL_TOKEN_ENV_KEY]: "test-token" },
    source: "company_secret",
    secretName: "GH_TOKEN",
  }));
}

function realizeInput(fixture: PartialCloneFixture, overrides: Record<string, unknown> = {}) {
  return {
    base: {
      baseCwd: fixture.repoRoot,
      source: "project_primary" as const,
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: "refs/remotes/origin/master",
    },
    config: {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}",
        worktreeParentDir: fixture.worktreeParentDir,
      },
    },
    issue: { id: "issue-1", identifier: "NUR-281", title: "Runner credentials" },
    agent: { id: "agent-1", name: "DevOps", companyId: "company-1" },
    ...overrides,
  };
}

/**
 * Install a `post-checkout` hook that records the env git ran with. `git worktree add` runs it
 * as a child of the process under test, so whatever it captures is that process's env.
 */
async function installEnvCapturingHook(fixture: PartialCloneFixture) {
  const hooksDir = path.join(path.dirname(fixture.repoRoot), "hooks");
  const capturePath = path.join(path.dirname(fixture.repoRoot), "hook-env.txt");
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(
    path.join(hooksDir, "post-checkout"),
    [
      "#!/bin/sh",
      `printf 'token=%s\\nprompt=%s\\n' "\${${GIT_CREDENTIAL_TOKEN_ENV_KEY}:-unset}" "\${GIT_TERMINAL_PROMPT:-unset}" > ${JSON.stringify(capturePath)}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return { hooksDir, capturePath };
}

describe("workspace preparation credentials in a partial clone", () => {
  it("fails to create a worktree when the promisor remote needs a credential it does not have", async () => {
    // Regression guard for the NUR-281 signature: without a credential the lazy fetch behind
    // `git worktree add` fails and workspace preparation dies mid-checkout.
    const fixture = await createPartialClone();
    const lazyFile = await addRemoteCommitWithLazyBlob(fixture, "lazy.txt");
    await breakPromisor(fixture);

    const error = await realizeExecutionWorkspace(realizeInput(fixture)).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("from promisor remote");
    await expect(fs.stat(path.join(fixture.worktreeParentDir, "NUR-281", lazyFile)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the worktree and materializes lazily fetched files when a credential is provided", async () => {
    const fixture = await createPartialClone();
    const lazyFile = await addRemoteCommitWithLazyBlob(fixture, "lazy.txt");
    await breakPromisor(fixture);
    const resolveGitAuth = fakeCredentialProvider(fixture);

    const realized = await realizeExecutionWorkspace(realizeInput(fixture, { resolveGitAuth }));

    expect(realized.created).toBe(true);
    // The blob was absent locally, so this file existing proves the authenticated lazy fetch ran.
    await expect(fs.readFile(path.join(realized.worktreePath!, lazyFile), "utf8"))
      .resolves.toContain("lazy.txt");
    expect(resolveGitAuth).toHaveBeenCalled();
  });

  it("authenticates the reset --hard that refreshes an unstarted reused worktree", async () => {
    // The inherited-workspace signature from NUR-275: `git reset --hard <sha>` failed with
    // `could not read Username`. Refreshing a reused worktree forward rewrites its working
    // tree, so it lazily fetches just like creating one does.
    const fixture = await createPartialClone();
    const resolveGitAuth = fakeCredentialProvider(fixture);

    // First realization happens while the promisor is still reachable.
    const first = await realizeExecutionWorkspace(realizeInput(fixture));
    expect(first.created).toBe(true);
    const worktreePath = first.worktreePath!;
    const headBefore = await git(worktreePath, ["rev-parse", "HEAD"]);

    // Advance the remote, then take the promisor away: the reuse path must now fetch the new
    // commit's blob to reset the clean, unstarted worktree forward.
    const lazyFile = await addRemoteCommitWithLazyBlob(fixture, "refreshed.txt");
    await breakPromisor(fixture);

    const unauthenticated = await realizeExecutionWorkspace(realizeInput(fixture)).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(unauthenticated?.message).toContain("from promisor remote");

    const reused = await realizeExecutionWorkspace(realizeInput(fixture, { resolveGitAuth }));

    expect(reused.created).toBe(false);
    expect(reused.worktreePath).toBe(worktreePath);
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).not.toBe(headBefore);
    await expect(fs.readFile(path.join(worktreePath, lazyFile), "utf8"))
      .resolves.toContain("refreshed.txt");
  });

  it("passes the credential env and disables terminal prompts for the worktree checkout", async () => {
    const fixture = await createPartialClone();
    await addRemoteCommitWithLazyBlob(fixture, "lazy.txt");
    await breakPromisor(fixture);
    const { hooksDir, capturePath } = await installEnvCapturingHook(fixture);
    const resolveGitAuth = fakeCredentialProvider(fixture, ["-c", `core.hooksPath=${hooksDir}`]);

    await realizeExecutionWorkspace(realizeInput(fixture, { resolveGitAuth }));

    const captured = await fs.readFile(capturePath, "utf8");
    expect(captured).toContain("token=test-token");
    // Fail-closed: git must never reach for /dev/tty during workspace preparation.
    expect(captured).toContain("prompt=0");
  });

  it("disables terminal prompts even when no credential provider is configured", async () => {
    // Ambient behavior is preserved for a full clone, but prompt suppression is unconditional:
    // a credential-less operation must fail fast and say so instead of blocking on a prompt.
    const fixture = await createPartialClone();
    const { hooksDir, capturePath } = await installEnvCapturingHook(fixture);
    // Repo-local config, since without a provider there are no configArgs to carry it.
    await git(fixture.repoRoot, ["config", "core.hooksPath", hooksDir]);

    await realizeExecutionWorkspace(realizeInput(fixture));

    const captured = await fs.readFile(capturePath, "utf8");
    expect(captured).toContain("prompt=0");
    expect(captured).toContain("token=unset");
  });

  it("recreates a missing persisted worktree with the credential during restore", async () => {
    // The inherited-workspace restore path re-adds the worktree, which is the same lazily
    // fetching checkout.
    const fixture = await createPartialClone();
    const lazyFile = await addRemoteCommitWithLazyBlob(fixture, "lazy.txt");
    await breakPromisor(fixture);
    const worktreePath = path.join(fixture.worktreeParentDir, "NUR-281-restore");
    const resolveGitAuth = fakeCredentialProvider(fixture);

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: fixture.repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "refs/remotes/origin/master",
      },
      workspace: {
        id: "execution-workspace-1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: worktreePath,
        providerRef: worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "refs/remotes/origin/master",
        branchName: "NUR-281-restore",
        metadata: null,
      },
      issue: { id: "issue-1", identifier: "NUR-281", title: "Runner credentials" },
      agent: { id: "agent-1", name: "DevOps", companyId: "company-1" },
      resolveGitAuth,
    });

    expect(restored).not.toBeNull();
    await expect(fs.readFile(path.join(worktreePath, lazyFile), "utf8")).resolves.toContain("lazy.txt");
  });
});
