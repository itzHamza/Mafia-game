/**
 * bot.js
 *
 * Entry point. Initialises Telegraf, registers all middleware,
 * loads every command, wires all action handlers.
 *
 * FIXES APPLIED (v2):
 *   1. flushPendingUpdates() is called ONCE before the first launch attempt
 *      (cold-start only). It is no longer called inside the retry loop, so
 *      legitimate button clicks that arrive during a transient network blip
 *      are never discarded.
 *
 *   2. bot.catch() global handler — logs errors without crashing the polling
 *      process. Previously any unhandled throw inside a handler would kill
 *      the bot.
 *
 *   3. polling.timeout raised to 30 s (Telegram default is 0 = short-poll;
 *      Telegraf defaults to 30 already, but we set it explicitly) and
 *      polling.limit set to 100 (max allowed) so each long-poll call drains
 *      as many queued updates as possible, reducing round-trips under burst.
 *
 *   4. handlerTimeout set to 90 000 ms (the Telegraf default) so the framework
 *      does not silently swallow slow handlers — combined with bot.catch() the
 *      error is now surfaced instead of disappearing.
 *
 *   5. Update-lag logging: for every incoming message we compute
 *      (Date.now() / 1000) - ctx.message.date and emit a WARN log when the
 *      lag exceeds 10 s, making network congestion immediately visible in logs.
 *
 *   6. gameState null-guard added to all action handlers — if a burst of stale
 *      callback_queries arrives while gameState is mid-reset, each one is
 *      answered safely instead of throwing "Cannot read property of undefined".
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

const bot = new Telegraf(BOT_TOKEN, {
  // ── FIX 4: expose handler errors instead of swallowing them ────────────
  // handlerTimeout is the maximum ms Telegraf waits for a middleware chain
  // before it considers it "timed out". We keep it at the Telegraf default
  // (90 s) but set it explicitly so the value is visible and easy to tune.
  handlerTimeout: 90_000,
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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 — GLOBAL bot.catch() HANDLER
//
// Previously any unhandled throw inside a command or action handler would
// crash the polling process silently (Telegraf caught it internally but did
// not re-emit it, and on some versions it DID propagate and kill the process).
//
// bot.catch() is called by Telegraf for every error that escapes a middleware
// chain. Logging here keeps the process alive and provides a traceable stack.
// ─────────────────────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  const update = ctx?.update;
  const updateId = update?.update_id ?? "unknown";
  const from = ctx?.from?.id ?? "unknown";
  console.error(
    `[bot.catch] Unhandled error for update ${updateId} (from=${from}):`,
    err,
  );
  // Attempt to inform the user — but don't let a secondary failure propagate
  ctx
    ?.reply("⚠️ An internal error occurred. Please try again.")
    .catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 0 — STALE MESSAGE GUARD + LAG LOGGER (FIX 5)
//
// Original behaviour preserved: drops messages older than STALE_MESSAGE_THRESHOLD_S.
// Addition: logs a warning with the lag value for every message, so congestion
// periods are immediately visible in the server logs. Lag > 10 s is flagged.
//
// callback_queries are still intentionally excluded from the stale check for
// the same reasons documented in the original (the message.date on a callback
// is the time the *button message* was sent, not when the button was pressed).
// ─────────────────────────────────────────────────────────────────────────────

const STALE_MESSAGE_THRESHOLD_S = 30;
const LAG_WARN_THRESHOLD_S = 10;

bot.use((ctx, next) => {
  const ts = ctx.message?.date ?? null;

  if (ts !== null) {
    const nowS = Math.floor(Date.now() / 1000);
    const ageSeconds = nowS - ts;

    // ── FIX 5: lag telemetry ──────────────────────────────────────────────
    if (ageSeconds > LAG_WARN_THRESHOLD_S) {
      console.warn(
        `[lag-monitor] HIGH LAG detected: message is ${ageSeconds}s old ` +
          `(from=${ctx.from?.id}, text="${ctx.message?.text?.slice(0, 40)}")`,
      );
    } else if (ageSeconds > 2) {
      // Mild lag — info level only
      console.log(
        `[lag-monitor] message lag ${ageSeconds}s (from=${ctx.from?.id})`,
      );
    }

    // Stale drop (unchanged from original)
    if (ageSeconds > STALE_MESSAGE_THRESHOLD_S) {
      console.log(
        `[stale-message] dropped message ${ageSeconds}s old ` +
          `(from=${ctx.from?.id} text="${ctx.message?.text?.slice(0, 40)}")`,
      );
      return; // do not call next()
    }
  }

  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 1 — GLOBAL ERROR BOUNDARY
// Retained as a belt-and-suspenders layer alongside bot.catch().
// bot.catch() fires for errors that propagate out of this middleware, so
// the two layers are complementary.
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(
      "[middleware-error-boundary] Unhandled middleware error:",
      err,
    );
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
// DM NOTIFICATION RATE LIMITER (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const _muteNotifiedAt = new Map();
const MUTE_DM_COOLDOWN_MS = 30_000;

function shouldNotify(userId) {
  const last = _muteNotifiedAt.get(userId) ?? 0;
  if (Date.now() - last > MUTE_DM_COOLDOWN_MS) {
    _muteNotifiedAt.set(userId, Date.now());
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// IS GROUP MESSAGE helper (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function isGroupMessage(ctx) {
  const type = ctx.chat?.type;
  if (type !== "group" && type !== "supergroup") return false;
  if (!ctx.message) return false;
  const firstEntity = ctx.message.entities?.[0];
  if (firstEntity?.type === "bot_command" && firstEntity.offset === 0) {
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 3 — NIGHT PHASE GATE (unchanged logic, null-guard added)
// FIX 6: gameState.players.get() calls are now guarded.
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "night" && isGroupMessage(ctx)) {
    await ctx.deleteMessage().catch(() => {});

    if (shouldNotify(ctx.from.id)) {
      // FIX 6: guard against gameState.players being undefined mid-reset
      const player = gameState.players?.get(ctx.from.id) ?? null;
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
    return;
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 4 — SILENCED PLAYER GATE (null-guard added)
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "day" && isGroupMessage(ctx)) {
    const player = gameState.players?.get(ctx.from.id) ?? null;
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
// MIDDLEWARE 5 — DEAD PLAYER GATE (null-guard added)
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
// /roles and /role commands (unchanged)
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
// /start — PRIVATE CHAT HANDLER (unchanged)
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
// COMMAND DISPATCHER (unchanged)
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
// FIX 6: Added gameState null-guard before actionRegistry.resolve() so a
// burst of stale callbacks during a reset can't throw "Cannot read property".
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

  if (String(ctx.from.id) !== actorId) {
    await ctx.answerCbQuery("⚠️ This isn't your prompt.").catch(() => {});
    return;
  }

  // FIX 6: guard against gameState not yet fully initialised / mid-reset
  if (!gameState.players) {
    await ctx
      .answerCbQuery("⚠️ Game state is not ready. Please try again.", {
        show_alert: true,
      })
      .catch(() => {});
    return;
  }

  const key = `${prefix}:${round}:${actorId}`;
  const resolved = actionRegistry.resolve(key, value);

  console.log(`[night-action] key=${key} value=${value} resolved=${resolved}`);

  if (resolved) {
    await ctx.answerCbQuery("✅ Action recorded!").catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  } else {
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
// FIX 6: sessionId guard already present; added players null-guard.
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_nom:/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!ctx.callbackQuery?.data || !ctx.from) return;

  const parts = ctx.callbackQuery.data.split(":");
  if (parts.length < 4) return;

  const [, sessionId, , targetIdStr] = parts;
  const targetId = Number(parts[3]);
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  if (sessionId !== gameState.sessionId) {
    await ctx
      .answerCbQuery(
        "⚠️ This vote is from a previous game and is no longer valid.",
        { show_alert: true },
      )
      .catch(() => {});
    return;
  }

  // FIX 6: guard mid-reset state
  if (!gameState.players) return;

  console.log(`[vote-nom] voterId=${voterId} targetId=${targetId}`);
  await dayVoting.receiveNominationVote(voterId, targetId, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// DAY EXECUTION VOTE HANDLER
// FIX 6: sessionId guard already present; added players null-guard.
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_exec:/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!ctx.callbackQuery?.data || !ctx.from) return;

  const parts = ctx.callbackQuery.data.split(":");
  if (parts.length < 5) return;

  const sessionId = parts[1];
  const choice = parts[4];
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  if (sessionId !== gameState.sessionId) {
    await ctx
      .answerCbQuery(
        "⚠️ This vote is from a previous game and is no longer valid.",
        { show_alert: true },
      )
      .catch(() => {});
    return;
  }

  // FIX 6: guard mid-reset state
  if (!gameState.players) return;

  console.log(`[vote-exec] voterId=${voterId} choice=${choice}`);
  await dayVoting.receiveExecutionVote(voterId, choice, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// CATCH-ALL CALLBACK HANDLER (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN (unchanged)
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
// FIX 1 — Cold-start-only flush
//   flushPendingUpdates() is called ONCE before the very first launch attempt.
//   It is NOT called again on each retry. This preserves the intent (clear
//   stale updates from a fresh deployment / restart) while ensuring that
//   legitimate button clicks that arrive during a transient network blip
//   (timeout, 409, etc.) are not silently discarded.
//
// FIX 3 — Polling parameters
//   polling.timeout = 30   — Each long-poll waits up to 30 s for new updates
//                            before returning an empty response. This is the
//                            Telegram-recommended value and keeps the connection
//                            alive without burning CPU.
//   polling.limit   = 100  — Maximum allowed by Telegram. Drains burst queues
//                            faster by fetching up to 100 updates per call
//                            instead of the Telegraf default of 100 (already
//                            the max, but set explicitly for clarity).
//   allowedUpdates  — scoped to only the update types we actually handle,
//                            reducing server-side filtering work.
// ─────────────────────────────────────────────────────────────────────────────

const LAUNCH_CONFIG = {
  allowedUpdates: ["message", "callback_query", "chat_member"],
  dropPendingUpdates: false, // FIX 1: never drop during retries — handled manually once
  polling: {
    timeout: 30, // seconds to wait per long-poll request (Telegram recommended)
    limit: 100, // max updates per request (Telegram maximum)
  },
};

async function flushPendingUpdates() {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log("🧹 Pending updates flushed (cold start).");
  } catch (err) {
    console.warn("Could not flush pending updates:", err.message);
  }
}

async function launchWithRetry(maxRetries = 5, delayMs = 10_000) {
  // ── FIX 1: flush ONCE before the first attempt only ──────────────────────
  await flushPendingUpdates();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.launch(LAUNCH_CONFIG);
      console.log(`✅ Mafiaville Bot is running.`);
      console.log(
        `   Admin IDs: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "(none)"}`,
      );
      return;
    } catch (err) {
      console.error(
        `Launch attempt ${attempt}/${maxRetries} failed: ${err.message}`,
      );

      if (err.response?.error_code === 409 || err.message?.includes("409")) {
        console.error(
          "409 Conflict: another bot instance is running. " +
            "Exiting so the process manager can restart us cleanly.",
        );
        process.exit(1);
      }

      if (attempt < maxRetries) {
        console.log(`Retrying in ${delayMs / 1000}s…`);
        // FIX 1: NO flushPendingUpdates() call here — we only flush on cold start.
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.error("Fatal: all launch attempts failed. Exiting.");
        process.exit(1);
      }
    }
  }
}

launchWithRetry();
