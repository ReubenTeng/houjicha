import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyEnvFile, ConfigError, loadConfig } from "./config.js";

const TOKEN = `123456789:${"A".repeat(35)}`;

describe("loadConfig", () => {
  test("requires a token", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "   " })).toThrow(
      /TELEGRAM_BOT_TOKEN is required/,
    );
  });

  test("rejects a malformed token without echoing it", () => {
    const secret = "super-secret-not-a-telegram-token";
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: secret })).toThrow(
      ConfigError,
    );
    try {
      loadConfig({ TELEGRAM_BOT_TOKEN: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
  });

  test("trims a valid token", () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: `  ${TOKEN}  ` })).toEqual({
      botToken: TOKEN,
    });
  });
});

describe("applyEnvFile", () => {
  test("fills only missing keys and ignores comments", () => {
    const directory = mkdtempSync(join(tmpdir(), "houjicha-env-"));
    const filePath = join(directory, ".env");
    writeFileSync(
      filePath,
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=\"from-file\"",
        "ALREADY=from-file",
        "not a pair",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ALREADY: "from-shell" };

    applyEnvFile(filePath, env);
    applyEnvFile(join(directory, "missing.env"), env);

    expect(env.TELEGRAM_BOT_TOKEN).toBe("from-file");
    expect(env.ALREADY).toBe("from-shell");
  });
});
