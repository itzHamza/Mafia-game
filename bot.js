/**
 * bot.js
 *
 * Entry point. Initialises Telegraf, registers all middleware,
 * loads every command, wires all action handlers.
 */

"use strict";

require("dotenv").config();

const { Telegraf } = require("telegraf");
const gameState = require("./gameState");
const actionRegistry = require("./roles/actionRegistry");
const dayVoting = require("./roles/dayVoting");

// ─────────────────────────────────────────────────────────────────────────────
// BOT INITIALISATION
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("FATAL: BOT_TOKEN not set in environment / .env file.");
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

const bot = new Telegraf(BOT_TOKEN);

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

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 1 — GLOBAL ERROR BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error("Unhandled middleware error:", err);
    if (ctx.chat) {
      await ctx
        .reply("⚠️ An internal error occurred. Please try again.")
        .catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 2 — IGNORE BOTS
// ─────────────────────────────────────────────────────────────────────────────

bot.use((ctx, next) => {
  if (ctx.from?.is_bot) return;
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 3 — SILENCED PLAYER GATE (group chat only)
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (
    ctx.chat?.type !== "private" &&
    ctx.message?.text &&
    gameState.phase === "day"
  ) {
    const player = gameState.players.get(ctx.from.id);
    if (player?.silencedLastRound) {
      await ctx.deleteMessage().catch(() => {});
      await bot.telegram
        .sendMessage(
          ctx.from.id,
          `🤫 <b>You are silenced today.</b>\n\n` +
            `The Mafia's Silencer visited you last night. ` +
            `You cannot speak at today's Town Hall meeting.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      return;
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 4 — DEAD PLAYER GATE (group chat only)
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (
    ctx.chat?.type !== "private" &&
    ctx.message?.text &&
    gameState.isGameActive
  ) {
    const player = gameState.players.get(ctx.from.id);
    if (player && !player.isAlive) {
      await ctx.deleteMessage().catch(() => {});
      await bot.telegram
        .sendMessage(
          ctx.from.id,
          `👻 <b>You are dead and cannot communicate with the living.</b>\n\n` +
            `You may watch the game, but please don't share information ` +
            `about your role or what you observed.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      return;
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// /roles and /role commands
// ─────────────────────────────────────────────────────────────────────────────

bot.command("roles", async (ctx) => {
  const rolesCmd = commands.get("roles");
  await rolesCmd.execute(ctx, [], gameState, bot, "all");
});

bot.command("role", async (ctx) => {
  const rawText = ctx.message?.text ?? "";
  const args = rawText.trim().split(/\s+/).slice(1);
  const rolesCmd = commands.get("roles");
  await rolesCmd.execute(ctx, args, gameState, bot, "single");
});

// ─────────────────────────────────────────────────────────────────────────────
// /start — PRIVATE CHAT HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") {
    return ctx.reply(
      `👋 <b>Mafiaville Bot</b>\n\n` +
        `Commands:\n` +
        `/join — Join the lobby\n` +
        `/leave — Leave the lobby\n` +
        `/party — List current players\n` +
        `/remove @player — Remove a player (host only)\n` +
        `/kick @player — Kick mid-game (host only)\n` +
        `/setup — Assign roles (host only)\n` +
        `/startgame — Start the game (host only)\n` +
        `/endgame — Force-end the game (host only)\n` +
        `/settings — View/change settings (host only)\n` +
        "/write &lt;line&gt; &lt;text&gt; — Edit your last will (DM only)\n" +
        "/erase &lt;line&gt; — Erase a will line (DM only)",
      { parse_mode: "HTML" },
    );
  }

  const userId = ctx.from.id;

  await ctx.reply(
    `✅ <b>You're all set!</b>\n\n` +
      `I can now send you private messages during the game.\n\n` +
      `Head back to the group chat and join with /join.`,
    { parse_mode: "HTML" },
  );

  const player = gameState.players.get(userId);
  if (player) {
    console.log(`✅ DM confirmed: ${player.username} (${userId})`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, cmd] of commands) {
  bot.command(name, async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const parts = rawText.trim().split(/\s+/);
    const args = parts.slice(1);
    await cmd.execute(ctx, args, gameState, bot);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT ACTION CALLBACK HANDLER
//
// BUG FIX: Previously answerCbQuery() was called unconditionally at the top,
// meaning when resolved=false (stale button after bot restart) the user got
// NO feedback at all — the button just silently did nothing.
//
// Fix: answer AFTER the resolve check so we can provide contextual messages.
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^na/, async (ctx) => {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const parts = data.split(":");
  if (parts.length < 4) {
    console.warn("[night-action] malformed callback_data:", data);
    await ctx.answerCbQuery("⚠️ Malformed action data.").catch(() => {});
    return;
  }

  const prefix = parts[0];
  const round = parts[1];
  const actorId = parts[2];
  const value = parts.slice(3).join(":");

  // Guard: only the correct player can press their own buttons
  if (String(ctx.from.id) !== actorId) {
    await ctx.answerCbQuery("⚠️ This isn't your prompt.").catch(() => {});
    return;
  }

  const key = `${prefix}:${round}:${actorId}`;
  const resolved = actionRegistry.resolve(key, value);

  console.log(`[night-action] key=${key} value=${value} resolved=${resolved}`);

  if (resolved) {
    // Acknowledge and collapse the keyboard
    await ctx.answerCbQuery("✅ Action recorded!").catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  } else {
    // BUG FIX: stale button (bot restarted mid-game, registry was wiped).
    // Previously this branch was silent — user got no feedback and saw a spinner.
    await ctx
      .answerCbQuery(
        "⚠️ This action is no longer valid. The game may have been reset.",
        { show_alert: true },
      )
      .catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DAY NOMINATION VOTE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_nom:/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!ctx.callbackQuery?.data || !ctx.from) return;

  const parts = ctx.callbackQuery.data.split(":");
  if (parts.length < 3) return;

  const targetId = Number(parts[2]);
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  console.log(`[vote-nom] voterId=${voterId} targetId=${targetId}`);
  await dayVoting.receiveNominationVote(voterId, targetId, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// DAY EXECUTION VOTE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_exec:/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!ctx.callbackQuery?.data || !ctx.from) return;

  const parts = ctx.callbackQuery.data.split(":");
  if (parts.length < 4) return;

  const choice = parts[3];
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  console.log(`[vote-exec] voterId=${voterId} choice=${choice}`);
  await dayVoting.receiveExecutionVote(voterId, choice, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// CATCH-ALL CALLBACK HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  actionRegistry.clear();
  dayVoting.clearActiveSessions();
  bot.stop(signal);
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH WITH RETRY
//
// BUG FIX: The original bot.launch() had no retry logic. Telegram's API
// occasionally returns a timeout (especially if another instance is still
// holding a long-poll connection), which caused a hard crash.
//
// Fix: retry up to 5 times with a 10-second delay between attempts.
// Each retry gives the previous instance time to release the connection.
// ─────────────────────────────────────────────────────────────────────────────

const LAUNCH_CONFIG = {
  allowedUpdates: ["message", "callback_query", "chat_member"],
};

async function launchWithRetry(maxRetries = 5, delayMs = 10_000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.launch(LAUNCH_CONFIG);
      console.log(`✅ Mafiaville Bot is running.`);
      console.log(
        `   Admin IDs: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "(none)"}`,
      );
      return; // success
    } catch (err) {
      console.error(
        `Launch attempt ${attempt}/${maxRetries} failed: ${err.message}`,
      );

      // 409 = another instance is actively holding the long-poll connection.
      // Retrying immediately just makes two instances fight each other.
      // Exit with code 1 so the process manager (e.g. Railway, PM2) can restart
      // cleanly — by which point the old instance will have released the connection.
      if (err.response?.error_code === 409 || err.message?.includes("409")) {
        console.error(
          "409 Conflict: another bot instance is running. " +
            "Exiting so the process manager can restart us cleanly.",
        );
        process.exit(1);
      }

      if (attempt < maxRetries) {
        console.log(`Retrying in ${delayMs / 1000}s…`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.error("Fatal: all launch attempts failed. Exiting.");
        process.exit(1);
      }
    }
  }
}

launchWithRetry();
