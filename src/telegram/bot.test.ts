import { type Bot, type Transformer } from "grammy";
import { describe, expect, test } from "vitest";
import { START_MESSAGE, createBot } from "./bot.js";
import { createLogger, type LogWriter } from "./logger.js";

const TOKEN = `123456789:${"A".repeat(35)}`;

type TelegramUpdate = Parameters<Bot["handleUpdate"]>[0];

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Foundation",
  username: "foundation_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const writer: LogWriter = {
    info: (line) => {
      lines.push(line);
    },
    error: (line) => {
      lines.push(line);
    },
  };
  return { logger: createLogger(writer), lines };
}

function commandUpdate(text: string): TelegramUpdate {
  return {
    update_id: text.length,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 42, type: "private", first_name: "UniquePersonName" },
      from: { id: 7, is_bot: false, first_name: "UniquePersonName" },
      text,
      entities: [{ offset: 0, length: text.length, type: "bot_command" }],
    },
  } as TelegramUpdate;
}

describe("createBot", () => {
  test("replies to /start without calling Telegram", async () => {
    const { logger, lines } = captureLogger();
    const bot = createBot({ botToken: TOKEN }, logger);
    bot.botInfo = BOT_INFO;
    const sent: Array<{ chatId: unknown; text: unknown }> = [];
    const transformer: Transformer = async (prev, method, payload) => {
      if (method !== "sendMessage") {
        return prev(method, payload);
      }
      const body = payload as { chat_id?: unknown; text?: unknown };
      sent.push({ chatId: body.chat_id, text: body.text });
      return {
        ok: true,
        result: {
          message_id: 11,
          date: 1_700_000_000,
          chat: { id: 42, type: "private", first_name: "UniquePersonName" },
          text: START_MESSAGE,
        },
      } as never;
    };
    bot.api.config.use(transformer);

    await bot.handleUpdate(commandUpdate("/start"));
    await bot.handleUpdate(commandUpdate("/start@foundation_bot"));

    expect(sent).toEqual([
      { chatId: 42, text: START_MESSAGE },
      { chatId: 42, text: START_MESSAGE },
    ]);
    expect(lines.join("\n")).not.toContain("UniquePersonName");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
