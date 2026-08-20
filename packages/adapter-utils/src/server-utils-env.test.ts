import { describe, expect, it } from "vitest";
import {
  buildWorkloadProcessEnv,
  sanitizeInheritedControlPlaneEnv,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("inherits only non-secret shell/tool state", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      DATABASE_URL: "postgres://paperclip.test/control-plane",
      BETTER_AUTH_SECRET: "host-auth-secret",
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_ID: "production-id",
      RAILWAY_TOKEN: "railway-host-credential",
      API_TOKEN: "generic-host-credential",
      GITHUB_TOKEN: "github-host-credential",
      ANTHROPIC_API_KEY: "anthropic-host-credential",
      OPENAI_API_KEY: "openai-host-credential",
      AWS_SECRET_ACCESS_KEY: "aws-host-credential",
      CLOUDFLARE_API_TOKEN: "cloudflare-host-credential",
      PGPASSWORD: "postgres-host-credential",
      REDIS_URL: "redis://host-credential@redis.example.test",
      HTTPS_PROXY: "https://host-token@proxy.example.test",
      LC_TOKEN: "locale-shaped-host-secret",
      HOME: "/home/paperclip",
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      NO_PROXY: "127.0.0.1,localhost",
      XDG_CACHE_HOME: "/home/paperclip/.cache",
    })).toEqual({
      HOME: "/home/paperclip",
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      NO_PROXY: "127.0.0.1,localhost",
      XDG_CACHE_HOME: "/home/paperclip/.cache",
    });
  });

  it("allows an explicit workload overlay to opt back into sanitized keys", () => {
    expect(buildWorkloadProcessEnv(
      {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://workspace.test/app",
        CUSTOM_PROJECT_SETTING: "enabled",
        GITHUB_TOKEN: "github-explicit-workload-credential",
        HTTPS_PROXY: "https://workspace-token@proxy.example.test",
      },
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://paperclip.test/control-plane",
        PAPERCLIP_HOME: "/srv/paperclip",
        PATH: "/usr/bin",
      },
    )).toEqual({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://workspace.test/app",
      CUSTOM_PROJECT_SETTING: "enabled",
      GITHUB_TOKEN: "github-explicit-workload-credential",
      HTTPS_PROXY: "https://workspace-token@proxy.example.test",
      PATH: "/usr/bin",
    });
  });

  it("classifies inherited keys and applies explicit overrides case-insensitively on Windows", () => {
    expect(buildWorkloadProcessEnv(
      {
        PATH: "C:\\workspace\\bin",
        node_env: "test",
      },
      {
        Path: "C:\\host\\bin",
        NoDe_EnV: "production",
        gItHuB_tOkEn: "host-secret",
        SystemRoot: "C:\\Windows",
      },
      "win32",
    )).toEqual({
      PATH: "C:\\workspace\\bin",
      node_env: "test",
      SystemRoot: "C:\\Windows",
    });
  });

  it("keeps the full sanitizer available under its canonical name", () => {
    expect(sanitizeInheritedControlPlaneEnv({ NODE_ENV: "production", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
