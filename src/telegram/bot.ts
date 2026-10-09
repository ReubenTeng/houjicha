import { Bot, GrammyError, HttpError } from "grammy";
import type { TelegramConfig } from "./config.js";
import type { LogFields, Logger } from "./logger.js";

export const START_MESSAGE = "Bot is online.";

export interface CreateBotOptions {
  apiRoot?: string;
}

export function createBot(
  config: TelegramConfig,
  logger: Logger,
  options: CreateBotOptions = {},
): Bot {
  const bot =
    options.apiRoot === undefined
      ? new Bot(config.botToken)
      : new Bot(config.botToken, { client: { apiRoot: options.apiRoot } });

  bot.command("start", async (ctx) => {
    await ctx.reply(START_MESSAGE);
  });

  bot.catch((botError) => {
    logger.error("handler_error", describeHandlerError(botError.error));
  });

  return bot;
}

function describeHandlerError(error: unknown): LogFields {
  if (error instanceof GrammyError) {
    return { name: "GrammyError", code: error.error_code };
  }
  if (error instanceof HttpError) {
    return { name: "HttpError" };
  }
  if (error instanceof Error) {
    return { name: error.name };
  }
  return { name: "UnknownError" };
}
