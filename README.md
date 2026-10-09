# Houjicha

Long-polling Telegram bot. It answers `/start` with `Bot is online.` and `/tester` with `hello` plus the time that message was sent. Group-buying commands are not part of this slice.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- A bot token from [@BotFather](https://t.me/BotFather)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
TELEGRAM_BOT_TOKEN=123456789:AA...
```

The token is a BotFather string such as `123456789:AA...`: digits, a colon, then at least 30 letters, numbers, underscores, or hyphens.

The bot reads `.env` from the current directory when it starts. Existing environment variables win. A missing `.env` is fine if `TELEGRAM_BOT_TOKEN` is already exported.

## Run

```bash
npm run dev
```

Logs are single-line JSON. Info goes to stdout, errors to stderr. Lifecycle logs include the bot username. They do not include message text, names, or the token.

Open a private chat with the bot and send `/start` or `/tester`.

Ctrl+C, or `SIGTERM`, stops polling and then exits.

```bash
npm run build
npm start
```

`npm run dev` and `npm start` exit with status 1 if the token is missing or malformed.

## Checks

```bash
npm test
npm run typecheck
```
