import { existsSync, readFileSync } from "node:fs";

export interface TelegramConfig {
  botToken: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function applyEnvFile(filePath: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(filePath)) {
    return;
  }

  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const assignment = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separator = assignment.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = assignment.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key) || env[key] !== undefined) {
      continue;
    }

    env[key] = unquote(assignment.slice(separator + 1).trim());
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): TelegramConfig {
  const raw = env.TELEGRAM_BOT_TOKEN;
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN is required. Add it to the environment or a .env file before starting the bot.",
    );
  }

  const botToken = raw.trim();
  if (!TOKEN_PATTERN.test(botToken)) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN must look like 123456789:AA... from BotFather.",
    );
  }

  return { botToken };
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (!quoted || value.length < 2) {
    return value;
  }
  return value.slice(1, -1);
}
