import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const railwayConfig = readFileSync(path.join(repoRoot, "railway.toml"), "utf8");
const entrypoint = readFileSync(path.join(repoRoot, "scripts", "docker-entrypoint.sh"), "utf8");

function dockerStage(name: string) {
  const startPattern = new RegExp(`^FROM [^\\n]+ AS ${name}$`, "mi");
  const start = dockerfile.search(startPattern);
  expect(start, `Dockerfile must declare the ${name} stage`).toBeGreaterThanOrEqual(0);
  const next = dockerfile.slice(start + 1).search(/^FROM /m);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
}

describe("Railway image contract", () => {
  it("builds the root Dockerfile whose production layer provides sqlite3 and tini", () => {
    expect(railwayConfig).toMatch(/^builder = "DOCKERFILE"$/m);
    expect(railwayConfig).toMatch(/^dockerfilePath = "Dockerfile"$/m);
    expect(railwayConfig).toMatch(/^healthcheckTimeout = 600$/m);
    expect(dockerfile).toMatch(/^FROM production AS cloud$/m);

    const production = dockerStage("production");
    expect(production).toMatch(
      /apt-get install -y --no-install-recommends[^\n]*\bsqlite3\b/,
    );
    expect(production).toMatch(
      /apt-get install -y --no-install-recommends[^\n]*\btini\b/,
    );
    expect(production).toContain("command -v sqlite3 >/dev/null");
    expect(production).toContain("command -v tini >/dev/null");
  });

  it("keeps tini as PID 1 with an exec-only path to the non-root server", () => {
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]',
    );
    // tini is the container init/reaper and forwards signals to this child.
    // The child must replace itself in both privilege branches so Node stays
    // directly below tini rather than behind a shell that could absorb them.
    expect(entrypoint).toContain('exec "$@"');
    expect(entrypoint).toContain('exec gosu node "$@"');
  });
});
