/**
 * bot.js
 */

"use strict";

require("dotenv").config();

const { Telegraf } = require("telegraf");
const gameState = require("./gameState");
const actionRegistry = require("./roles/actionRegistry");
const dayVoting = require("./roles/dayVoting");
const { log, warn, err } = require("./logger");

// ─────────────────────────────────────────────────────────────────────────────
// BOT INIT
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  err("STARTUP", "BOT_TOKEN is missing from the .env file — bot cannot start.");
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

log(
  "STARTUP",
  `Bot is starting up. Admins: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "none configured"}`,
);

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90_000 });

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.catch((error, ctx) => {
  const from = ctx?.from?.id ?? "unknown";
  err("BOT", `Unexpected error (from user ${from}): ${error.message}`);
  ctx
    ?.reply("⚠️ An internal error occurred. Please try again.")
    .catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND LOADER
// ─────────────────────────────────────────────────────────────────────────────

const commands = new Map();
const commandModules = [
  require("./commands/join"),
  require("./commands/leave"),
  require("./commands/party"),
  require("./commands/remove"),
  require("./commands/write"),
  require("./commands/erase"),
  require("./commands/setup"),
  require("./commands/startgame"),
  require("./commands/endgame"),
  require("./commands/kick"),
  require("./commands/settings"),
  require("./commands/roles"),
];

for (const mod of commandModules) {
  commands.set(mod.name, mod);
}
log("STARTUP", `Loaded ${commandModules.length} commands.`);

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Ignore bots
// ─────────────────────────────────────────────────────────────────────────────

bot.use((ctx, next) => {
  if (ctx.from?.is_bot) return;
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Error boundary
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    err("BOT", `Error while handling update: ${error.message}`);
    if (ctx.chat) {
      await ctx
        .reply("⚠️ An internal error occurred. Please try again.")
        .catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DM RATE-LIMITER (for mute/dead/night notices)
// ─────────────────────────────────────────────────────────────────────────────

const _muteNotifiedAt = new Map();
const MUTE_DM_COOLDOWN = 30_000;

function shouldNotify(userId) {
  const last = _muteNotifiedAt.get(userId) ?? 0;
  if (Date.now() - last > MUTE_DM_COOLDOWN) {
    _muteNotifiedAt.set(userId, Date.now());
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — Detect group messages (non-command)
// ─────────────────────────────────────────────────────────────────────────────

function isGroupMessage(ctx) {
  const type = ctx.chat?.type;
  if (type !== "group" && type !== "supergroup") return false;
  if (!ctx.message) return false;
  const first = ctx.message.entities?.[0];
  if (first?.type === "bot_command" && first.offset === 0) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Night phase gate (block group messages at night)
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "night" && isGroupMessage(ctx)) {
    const from = ctx.from.id;
    await ctx.deleteMessage().catch(() => {});
    if (shouldNotify(from)) {
      const player = gameState.players?.get(from) ?? null;
      const msg = player
        ? `🌙 <b>It's night — the town is asleep.</b>\n\nCheck your DMs for your action prompt.`
        : `🌙 <b>The game is in its night phase.</b>\n\nGroup messages are disabled until morning.`;
      await bot.telegram
        .sendMessage(from, msg, { parse_mode: "HTML" })
        .catch(() => {});
    }
    return;
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Silenced player gate
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "day" && isGroupMessage(ctx)) {
    const player = gameState.players?.get(ctx.from.id) ?? null;
    if (player?.silencedLastRound) {
      await ctx.deleteMessage().catch(() => {});
      if (shouldNotify(ctx.from.id)) {
        await bot.telegram
          .sendMessage(ctx.from.id, `🤫 <b>You are silenced today.</b>`, {
            parse_mode: "HTML",
          })
          .catch(() => {});
      }
      return;
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Dead player gate
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.isGameActive && isGroupMessage(ctx)) {
    const player = gameState.players?.get(ctx.from.id) ?? null;
    if (player && !player.isAlive) {
      await ctx.deleteMessage().catch(() => {});
      if (shouldNotify(ctx.from.id)) {
        await bot.telegram
          .sendMessage(
            ctx.from.id,
            `👻 <b>You are dead and cannot communicate with the living.</b>`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
      return;
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// /roles and /role
// ─────────────────────────────────────────────────────────────────────────────

bot.command("roles", async (ctx) => {
  await commands.get("roles").execute(ctx, [], gameState, bot, "all");
});

bot.command("role", async (ctx) => {
  const args = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  await commands.get("roles").execute(ctx, args, gameState, bot, "single");
});

// ─────────────────────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") {
    return ctx.reply(
      `👋 <b>Mafiaville Bot</b>\n\nCommands:\n/join — Join the lobby\n/leave — Leave the lobby\n` +
        `/party — List current players\n/setup — Assign roles (host only)\n` +
        `/startgame — Start the game (host only)\n/endgame — Force-end (host only)`,
      { parse_mode: "HTML" },
    );
  }
  await ctx.reply(
    `✅ <b>You're all set!</b>\n\nI can now send you private messages.\n\nJoin with /join in the group.`,
    { parse_mode: "HTML" },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, cmd] of commands) {
  bot.command(name, async (ctx) => {
    const args = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
    await cmd.execute(ctx, args, gameState, bot);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT ACTION CALLBACK HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^na/, async (ctx) => {
  const data = ctx.callbackQuery?.data;
  const from = ctx.from?.id;

  if (!data || !from) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const parts = data.split(":");
  if (parts.length < 4) {
    await ctx.answerCbQuery("⚠️ Malformed action data.").catch(() => {});
    return;
  }

  const prefix = parts[0];
  const round = parts[1];
  const actorId = parts[2];
  const value = parts.slice(3).join(":");

  if (String(from) !== actorId) {
    await ctx.answerCbQuery("⚠️ This isn't your prompt.").catch(() => {});
    return;
  }

  if (!gameState.players) {
    await ctx
      .answerCbQuery("⚠️ Game state not ready.", { show_alert: true })
      .catch(() => {});
    return;
  }

  const key = `${prefix}:${round}:${actorId}`;
  const resolved = actionRegistry.resolve(key, value);

  if (resolved) {
    const player = gameState.players.get(from);
    log("NIGHT", `${player?.username ?? from} submitted their night action`);
    await ctx.answerCbQuery("✅ Action recorded!").catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  } else {
    warn(
      "NIGHT",
      `${gameState.players.get(from)?.username ?? from} pressed a button that is no longer valid`,
    );
    await ctx
      .answerCbQuery(
        "⚠️ This action is no longer valid. The game may have been reset.",
        { show_alert: true },
      )
      .catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOMINATION VOTE CALLBACK
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_nom:/, async (ctx) => {
  const from = ctx.from?.id;
  const data = ctx.callbackQuery?.data;

  await ctx.answerCbQuery().catch(() => {});
  if (!data || !from) return;

  const parts = data.split(":");
  if (parts.length < 4) return;

  const sessionId = parts[1];
  const targetId = Number(parts[3]);

  if (ctx.from.is_bot) return;

  if (sessionId !== gameState.sessionId) {
    await ctx
      .answerCbQuery("⚠️ Vote from previous game.", { show_alert: true })
      .catch(() => {});
    return;
  }

  if (!gameState.players) return;

  const voter = gameState.players.get(from);
  const target = gameState.players.get(targetId);
  log(
    "VOTE",
    `${voter?.username ?? from} nominated ${target?.username ?? targetId}`,
  );

  await dayVoting.receiveNominationVote(from, targetId, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION VOTE CALLBACK
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_exec:/, async (ctx) => {
  const from = ctx.from?.id;
  const data = ctx.callbackQuery?.data;

  await ctx.answerCbQuery().catch(() => {});
  if (!data || !from) return;

  const parts = data.split(":");
  if (parts.length < 5) return;

  const sessionId = parts[1];
  const choice = parts[4];

  if (ctx.from.is_bot) return;

  if (sessionId !== gameState.sessionId) {
    await ctx
      .answerCbQuery("⚠️ Vote from previous game.", { show_alert: true })
      .catch(() => {});
    return;
  }

  if (!gameState.players) return;

  const voter = gameState.players.get(from);
  log(
    "VOTE",
    `${voter?.username ?? from} voted ${choice === "guilty" ? "✅ Guilty" : "❌ Innocent"}`,
  );

  await dayVoting.receiveExecutionVote(from, choice, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// CATCH-ALL CALLBACK
// ─────────────────────────────────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal) {
  log("SHUTDOWN", `Shutting down (${signal})...`);
  actionRegistry.clear();
  dayVoting.clearActiveSessions();
  bot.stop(signal);
  process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH
// ─────────────────────────────────────────────────────────────────────────────

const LAUNCH_CONFIG = {
  allowedUpdates: ["message", "callback_query", "chat_member"],
  dropPendingUpdates: false,
  polling: { timeout: 30, limit: 100 },
};

async function flushPendingUpdates() {
  log("STARTUP", "Clearing any queued messages from before startup...");
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    warn("STARTUP", `Could not clear queue (non-fatal): ${e.message}`);
  }
}

async function launchWithRetry(maxRetries = 5, delayMs = 10_000) {
  await flushPendingUpdates();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.launch(LAUNCH_CONFIG);
      log("STARTUP", `✅ Bot is online and ready!`);
      return;
    } catch (e) {
      err(
        "STARTUP",
        `Failed to connect (attempt ${attempt}/${maxRetries}): ${e.message}`,
      );
      if (e.response?.error_code === 409 || e.message?.includes("409")) {
        err(
          "STARTUP",
          "Another instance of the bot is already running. Shutting down.",
        );
        process.exit(1);
      }
      if (attempt < maxRetries) {
        log("STARTUP", `Retrying in ${delayMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        err("STARTUP", "All connection attempts failed. Giving up.");
        process.exit(1);
      }
    }
  }
}

launchWithRetry();
