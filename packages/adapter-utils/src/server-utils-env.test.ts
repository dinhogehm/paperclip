import { describe, expect, it } from "vitest";
import {
  buildWorkloadProcessEnv,
  sanitizeInheritedControlPlaneEnv,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops host control-plane state while retaining workload credentials and shell state", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      DATABASE_URL: "postgres://paperclip.test/control-plane",
      BETTER_AUTH_SECRET: "host-auth-secret",
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_ID: "production-id",
      RAILWAY_TOKEN: "railway-workload-credential",
      OPENAI_API_KEY: "sk-workload",
      HOME: "/home/paperclip",
      PATH: "/usr/bin",
    })).toEqual({
      OPENAI_API_KEY: "sk-workload",
      RAILWAY_TOKEN: "railway-workload-credential",
      HOME: "/home/paperclip",
      PATH: "/usr/bin",
    });
  });

  it("allows an explicit workload overlay to opt back into sanitized keys", () => {
    expect(buildWorkloadProcessEnv(
      {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://workspace.test/app",
        CUSTOM_PROJECT_SETTING: "enabled",
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
      PATH: "/usr/bin",
    });
  });

  it("keeps the full sanitizer available under its canonical name", () => {
    expect(sanitizeInheritedControlPlaneEnv({ NODE_ENV: "production", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
