import { pathToFileURL } from "node:url";
import type { PollingOptions } from "grammy";
import { createBot } from "./bot.js";
import { applyEnvFile, ConfigError, loadConfig } from "./config.js";
import { createLogger, type LogFields, type Logger } from "./logger.js";

export interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

interface PollingBot {
  start(options?: PollingOptions): Promise<void>;
  stop(): Promise<void>;
}

export function isDirectRun(
  entryPath: string | undefined,
  moduleUrl: string,
): boolean {
  if (entryPath === undefined || entryPath === "") {
    return false;
  }
  return moduleUrl === pathToFileURL(entryPath).href;
}

export async function startPolling(
  bot: PollingBot,
  logger: Logger,
  signals: SignalSource,
): Promise<void> {
  let stopRequested = false;
  const stop = (): void => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    logger.info("bot_stopping");
    void bot.stop().catch((error: unknown) => {
      logger.error("bot_stop_error", { name: errorName(error) });
    });
  };

  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  logger.info("bot_starting");
  await bot.start({
    onStart: (info) => {
      const fields: LogFields | undefined =
        info.username === undefined ? undefined : { username: info.username };
      if (fields === undefined) {
        logger.info("bot_polling");
        return;
      }
      logger.info("bot_polling", fields);
    },
  });
  logger.info("bot_stopped");
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const logger = createLogger();
  const config = loadConfig(env);
  const bot = createBot(config, logger);
  await startPolling(bot, logger, {
    once(signal, listener) {
      process.once(signal, listener);
    },
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  applyEnvFile(".env", process.env);
  main().catch((error: unknown) => {
    const logger = createLogger();
    if (error instanceof ConfigError) {
      logger.error("config_error", { message: error.message });
    } else {
      logger.error("startup_error", { name: errorName(error) });
    }
    process.exitCode = 1;
  });
}
