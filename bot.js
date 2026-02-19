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
// MIDDLEWARE 0 — STALE MESSAGE GUARD
//
// Drops plain messages (/commands, text) that Telegram queued while the bot
// was offline and delivered in a burst on reconnect.
//
// IMPORTANT — callback_queries are intentionally NOT filtered here.
// ctx.callbackQuery.message.date is the timestamp of the *message that
// contains the buttons*, NOT when the player pressed the button. Filtering
// by that value would drop every legitimate vote cast more than N seconds
// after the vote message was sent — silently killing all execution votes.
// Stale callback_queries are already handled correctly by:
//   - actionRegistry.resolve() returning false for unknown keys (night actions)
//   - _nomSession / _execSession null checks (voting)
//   - The "✅ Action recorded" / stale-alert path in bot.action(/^na/)
//
// For messages we compare ctx.message.date (when the user sent it) against
// Date.now() — NOT against BOT_START_TIME. BOT_START_TIME would only drop
// messages sent before the process started, not genuinely old queued ones
// delivered late.
// ─────────────────────────────────────────────────────────────────────────────

const STALE_MESSAGE_THRESHOLD_S = 30;

bot.use((ctx, next) => {
  // Only apply to plain messages — skip callback_queries entirely
  const ts = ctx.message?.date ?? null;

  if (ts !== null) {
    const ageSeconds = Math.floor(Date.now() / 1000) - ts;
    if (ageSeconds > STALE_MESSAGE_THRESHOLD_S) {
      console.log(
        `[stale-message] dropped message ${ageSeconds}s old ` +
          `(from=${ctx.from?.id} text="${ctx.message?.text?.slice(0, 40)}")`,
      );
      return; // drop silently — do not call next()
    }
  }
  return next();
});

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
// DM NOTIFICATION RATE LIMITER
//
// All three message-gate middlewares below DM the player to explain why their
// message was deleted. Without a cooldown, a player who taps "send" repeatedly
// receives one DM per message — easily 10+ identical DMs in a row.
//
// _muteNotifiedAt tracks the last time we sent a gate-DM to each user.
// shouldNotify() returns true at most once every 30 seconds per user.
// ─────────────────────────────────────────────────────────────────────────────

const _muteNotifiedAt = new Map(); // userId (number) → Date.now() timestamp
const MUTE_DM_COOLDOWN_MS = 30_000; // 30 seconds between repeated notices

function shouldNotify(userId) {
  const last = _muteNotifiedAt.get(userId) ?? 0;
  if (Date.now() - last > MUTE_DM_COOLDOWN_MS) {
    _muteNotifiedAt.set(userId, Date.now());
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// IS GROUP MESSAGE helper
//
// The original gates only checked ctx.message?.text — this let stickers,
// photos, voice messages, etc. through unchecked during night/day restrictions.
// isGroupMessage() returns true for ANY non-command content in a group/supergroup.
// ─────────────────────────────────────────────────────────────────────────────

function isGroupMessage(ctx) {
  const type = ctx.chat?.type;
  if (type !== "group" && type !== "supergroup") return false;
  if (!ctx.message) return false;

  // Commands (/join, /party, etc.) must always pass through so the game works.
  // A message is a command if its first entity is of type "bot_command".
  const firstEntity = ctx.message.entities?.[0];
  if (firstEntity?.type === "bot_command" && firstEntity.offset === 0) {
    return false;
  }

  return true; // text, sticker, photo, video, voice, audio, document, poll, …
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 3 — NIGHT PHASE GATE (group chat only)
//
// During night ALL players must communicate via DM only. Nobody should be
// able to post anything in the group — alive or dead, in-game or spectator.
//
// Previously this gate did not exist. chatPermissions.muteAll() was supposed
// to cover it via restrictChatMember(), but that API call requires the bot to
// be a group admin with "Restrict members" permission. If that permission is
// missing the call fails silently, leaving everyone unmuted.
//
// This middleware is the bot-layer fallback: it catches every group message
// during night, deletes it, and DMs the sender an explanation (rate-limited).
// It works regardless of whether the bot has admin rights.
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "night" && isGroupMessage(ctx)) {
    await ctx.deleteMessage().catch(() => {});

    if (shouldNotify(ctx.from.id)) {
      const player = gameState.players.get(ctx.from.id);
      const isInGame = !!player;

      const msg = isInGame
        ? `🌙 <b>It's night — the town is asleep.</b>\n\n` +
          `All communication happens via private message during the night phase.\n` +
          `Check your DMs for your action prompt.`
        : `🌙 <b>The game is in its night phase.</b>\n\n` +
          `Group messages are disabled until morning.`;

      await bot.telegram
        .sendMessage(ctx.from.id, msg, { parse_mode: "HTML" })
        .catch(() => {});
    }
    return; // do not call next()
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 4 — SILENCED PLAYER GATE (group chat only, day phase)
//
// Silenced players cannot speak at Town Hall. Their messages are deleted and
// they receive a DM explanation (rate-limited to avoid DM spam).
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "day" && isGroupMessage(ctx)) {
    const player = gameState.players.get(ctx.from.id);
    if (player?.silencedLastRound) {
      await ctx.deleteMessage().catch(() => {});

      if (shouldNotify(ctx.from.id)) {
        await bot.telegram
          .sendMessage(
            ctx.from.id,
            `🤫 <b>You are silenced today.</b>\n\n` +
              `The Mafia's Silencer visited you last night. ` +
              `You cannot speak at today's Town Hall meeting.`,
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
// MIDDLEWARE 5 — DEAD PLAYER GATE (group chat only, any active game phase)
//
// Dead players cannot communicate with living players in the group.
// Messages are deleted and they receive a DM explanation (rate-limited).
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.isGameActive && isGroupMessage(ctx)) {
    const player = gameState.players.get(ctx.from.id);
    if (player && !player.isAlive) {
      await ctx.deleteMessage().catch(() => {});

      if (shouldNotify(ctx.from.id)) {
        await bot.telegram
          .sendMessage(
            ctx.from.id,
            `👻 <b>You are dead and cannot communicate with the living.</b>\n\n` +
              `You may watch the game, but please don't share information ` +
              `about your role or what you observed.`,
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
  if (parts.length < 4) return;

  const [, sessionId, , targetIdStr] = parts; // vote_nom:SESSION:ROUND:TARGETID
  const targetId = Number(parts[3]);
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  // Reject buttons from a previous game session
  if (sessionId !== gameState.sessionId) {
    await ctx
      .answerCbQuery(
        "⚠️ This vote is from a previous game and is no longer valid.",
        { show_alert: true },
      )
      .catch(() => {});
    return;
  }

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
  if (parts.length < 5) return;

  // vote_exec:SESSION:ROUND:NOMINEEID:CHOICE
  const sessionId = parts[1];
  const choice = parts[4];
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  // Reject buttons from a previous game session
  if (sessionId !== gameState.sessionId) {
    await ctx
      .answerCbQuery(
        "⚠️ This vote is from a previous game and is no longer valid.",
        { show_alert: true },
      )
      .catch(() => {});
    return;
  }

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
// LAUNCH
//
// Step 1: deleteWebhook({ drop_pending_updates: true })
//   This is a direct Telegram API call that flushes the server-side update
//   queue BEFORE polling starts. It works even if a previous instance is
//   still running, and regardless of whether bot.launch() succeeds on the
//   first attempt.
//
//   Why not rely on dropPendingUpdates in LAUNCH_CONFIG alone?
//   Because that flag only takes effect if bot.launch() succeeds on the
//   first try. When there's a 409 conflict or a 90s timeout on startup,
//   Telegraf never applies the flag — but Telegram has already queued all
//   updates, which flood in the moment polling eventually starts. This caused
//   an entire game's worth of stale button-presses to arrive simultaneously
//   3 minutes into a new game, triggering race conditions and crashes.
//
// Step 2: launchWithRetry
//   On 409: exit immediately. The process manager restarts us, and by then
//   the old instance will have released the connection.
//   On timeout: retry up to 5 times with 10s delay.
// ─────────────────────────────────────────────────────────────────────────────

const LAUNCH_CONFIG = {
  allowedUpdates: ["message", "callback_query", "chat_member"],
  dropPendingUpdates: true, // belt-and-suspenders alongside the explicit deleteWebhook call
};

async function flushPendingUpdates() {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log("🧹 Pending updates flushed.");
  } catch (err) {
    // Non-fatal — polling will still work, we just might get a burst of old updates.
    console.warn("Could not flush pending updates:", err.message);
  }
}

async function launchWithRetry(maxRetries = 5, delayMs = 10_000) {
  // Always flush first, before any launch attempt.
  await sleepAsync(5000); // give the old instance 5s to release the connection
  await flushPendingUpdates();

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
        // Flush again before each retry in case more updates queued up
        // during the wait period.
        await flushPendingUpdates();
      } else {
        console.error("Fatal: all launch attempts failed. Exiting.");
        process.exit(1);
      }
    }
  }
}

launchWithRetry();
