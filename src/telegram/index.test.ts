import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { GrammyError, type PollingOptions } from "grammy";
import { START_MESSAGE, createBot } from "./bot.js";
import { ConfigError } from "./config.js";
import { isDirectRun, main, startPolling, type SignalSource } from "./index.js";
import { createLogger, type LogWriter } from "./logger.js";

const TOKEN = `123456789:${"B".repeat(35)}`;
const botInfo = {
  id: 1,
  is_bot: true,
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
} as Parameters<NonNullable<PollingOptions["onStart"]>>[0];
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

class FakeSignals implements SignalSource {
  private readonly listeners = new Map<"SIGINT" | "SIGTERM", () => void>();

  once(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.listeners.set(signal, listener);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    this.listeners.get(signal)?.();
  }
}

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

describe("startup", () => {
  test("detects a direct run only for this module", () => {
    const entryPath = "/tmp/houjicha/src/telegram/index.ts";
    const moduleUrl = pathToFileURL(entryPath).href;
    expect(isDirectRun(undefined, moduleUrl)).toBe(false);
    expect(isDirectRun("", moduleUrl)).toBe(false);
    expect(isDirectRun("/tmp/other.ts", moduleUrl)).toBe(false);
    expect(isDirectRun(entryPath, moduleUrl)).toBe(true);
  });

  test("SIGTERM stops polling once", async () => {
    const signals = new FakeSignals();
    const events: string[] = [];
    let release = (): void => {};
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stops = 0;
    const bot = {
      async start(options?: PollingOptions): Promise<void> {
        await options?.onStart?.(botInfo);
        await stopped;
      },
      async stop(): Promise<void> {
        stops += 1;
        release();
      },
    };
    const logger = createLogger({
      info: (line) => {
        events.push((JSON.parse(line) as { event: string }).event);
      },
      error: () => {
        events.push("error");
      },
    });

    const pending = startPolling(bot, logger, signals);
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    await pending;

    expect(stops).toBe(1);
    expect(events).toEqual([
      "bot_starting",
      "bot_polling",
      "bot_stopping",
      "bot_stopped",
    ]);
  });

  test("main fails before connecting when the token is missing", async () => {
    await expect(main({})).rejects.toBeInstanceOf(ConfigError);
  });

  test("the dev entry fails clearly without a token", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TELEGRAM_BOT_TOKEN: "" };
    delete env.DEBUG;
    const child = spawn(process.execPath, ["--import", "tsx", "src/telegram/index.ts"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const [stdout, stderr, exit] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      once(child, "exit"),
    ]);

    expect(exit[0]).toBe(1);
    expect(stdout).toBe("");
    const logged = JSON.parse(stderr) as { level: string; event: string; fields: { message: string } };
    expect(logged.level).toBe("error");
    expect(logged.event).toBe("config_error");
    expect(logged.fields.message).toMatch(/TELEGRAM_BOT_TOKEN is required/);
  });

  test("starts polling, delivers one update, and stops on SIGINT", async () => {
    const privateText = "UniquePrivateText";
    const methods: string[] = [];
    const sentTexts: string[] = [];
    let settledUpdates = 0;
    let deliveredBatch = false;
    const signals = new FakeSignals();
    const server = createServer((request, response) => {
      void handleApi(request, response, {
        methods,
        sentTexts,
        onUpdatesSettled: () => {
          settledUpdates += 1;
        },
        nextUpdates: () => {
          if (deliveredBatch) {
            return [];
          }
          deliveredBatch = true;
          return [commandUpdate("/explode"), commandUpdate("/start")];
        },
        onSendMessage: () => {
          signals.emit("SIGINT");
        },
      }).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test API server did not bind to a TCP port.");
    }

    const { logger, lines } = captureLogger();
    const bot = createBot({ botToken: TOKEN }, logger, {
      apiRoot: `http://127.0.0.1:${address.port}`,
    });
    bot.use(async (ctx, next) => {
      if (ctx.msg?.text === "/explode") {
        throw new GrammyError(
          `400: Bad Request: ${privateText} ${TOKEN}`,
          { ok: false, error_code: 400, description: privateText },
          "sendMessage",
          { chat_id: 42, text: privateText },
        );
      }
      await next();
    });

    try {
      await Promise.race([
        startPolling(bot, logger, signals),
        timeout(3_000, "polling did not stop"),
      ]);
      await waitUntil(() => settledUpdates >= 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    expect(methods).toEqual(
      expect.arrayContaining(["getMe", "deleteWebhook", "getUpdates", "sendMessage"]),
    );
    expect(sentTexts).toEqual([START_MESSAGE]);
    const parsed = lines.map((line) => JSON.parse(line) as { event: string; fields?: { name?: string; code?: number; username?: string } });
    expect(parsed.map((entry) => entry.event)).toEqual([
      "bot_starting",
      "bot_polling",
      "handler_error",
      "bot_stopping",
      "bot_stopped",
    ]);
    expect(parsed[1]?.fields).toEqual({ username: "foundation_bot" });
    expect(parsed[2]?.fields).toEqual({ name: "GrammyError", code: 400 });
    const output = lines.join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(privateText);
    expect(output).not.toContain("UniquePersonName");
  });
});

interface ApiHandlers {
  methods: string[];
  sentTexts: string[];
  onUpdatesSettled: () => void;
  nextUpdates: () => unknown[];
  onSendMessage: () => void;
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: ApiHandlers,
): Promise<void> {
  const method = request.url?.split("/").pop()?.split("?")[0] ?? "";
  handlers.methods.push(method);
  const body = await readBody(request);

  if (method === "sendMessage") {
    const text = typeof body.text === "string" ? body.text : "";
    handlers.sentTexts.push(text);
    handlers.onSendMessage();
    respond(response, {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 42, type: "private" },
      text,
    });
    return;
  }

  if (method === "getMe") {
    respond(response, {
      id: 1,
      is_bot: true,
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
    });
    return;
  }

  if (method === "deleteWebhook") {
    respond(response, true);
    return;
  }

  if (method === "getUpdates") {
    response.on("finish", handlers.onUpdatesSettled);
    respond(response, handlers.nextUpdates());
    return;
  }

  response.writeHead(404);
  response.end();
}

function commandUpdate(text: string): unknown {
  return {
    update_id: text === "/explode" ? 1 : 2,
    message: {
      message_id: text.length,
      date: 1_700_000_000,
      chat: { id: 42, type: "private", first_name: "UniquePersonName" },
      from: { id: 7, is_bot: false, first_name: "UniquePersonName" },
      text,
      entities: [{ offset: 0, length: text.length, type: "bot_command" }],
    },
  };
}

function respond(response: ServerResponse, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, result }));
}

async function readBody(request: IncomingMessage): Promise<{ text?: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") {
    return {};
  }
  return JSON.parse(raw) as { text?: unknown };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) {
      throw new Error("Timed out waiting for the local Bot API.");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
}
