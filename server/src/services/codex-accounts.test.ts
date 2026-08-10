import { describe, expect, it } from "vitest";
import {
  parseCodexDevicePrompt,
  resolveCodexLoginCommand,
} from "./codex-accounts.js";

describe("Codex account device login", () => {
  it("recognizes the current variable-length device code and strips terminal escapes", () => {
    const prompt = parseCodexDevicePrompt([
      "\u001b[1mWelcome to Codex\u001b[0m\r\n",
      "Open https://auth.openai.com/codex/device\r\n",
      "Enter this one-time code: abcd-efghi\r\n",
    ].join(""));

    expect(prompt).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGHI",
    });
  });

  it("uses a pseudo-terminal wrapper on macOS", () => {
    expect(resolveCodexLoginCommand("/opt/codex", "darwin")).toEqual({
      command: "/usr/bin/script",
      args: ["-q", "/dev/null", "/opt/codex", "login", "--device-auth"],
      detached: true,
    });
  });

  it("quotes a configured executable safely for the Linux script wrapper", () => {
    const command = resolveCodexLoginCommand("/opt/Codex user's/bin/codex", "linux");

    expect(command.command).toBe("/usr/bin/script");
    expect(command.args[3]).toBe("'/opt/Codex user'\"'\"'s/bin/codex' login --device-auth");
    expect(command.detached).toBe(true);
  });
});
