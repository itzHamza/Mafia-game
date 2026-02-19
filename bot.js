/**
 * bot.js
 *
 * Entry point. Initialises Telegraf, registers all middleware,
 * loads every command, wires all action handlers.
 *
 * Discord equivalent: index.js / bot.js in the Discord bot:
 *   new Discord.Client()  → new Telegraf(token)
 *   client.login()        → bot.launch()
 *   client.on("message")  → bot.on("message") / bot.hears()
 *   client.on("ready")    → bot.launch().then(...)
 *
 * Architecture notes:
 *   1. gameState is a singleton — all commands and handlers share the same object.
 *   2. Middleware runs in registration order for every incoming update.
 *   3. Night-action callbacks are routed via actionRegistry (see roles/actionRegistry.js).
 *   4. Day-vote callbacks are routed into NominationSession / ExecutionSession
 *      (see roles/dayVoting.js) via receiveNominationVote / receiveExecutionVote.
 *   5. Silenced players are blocked at the middleware level (no channel permissions
 *      in Telegram — we gate at the bot layer instead).
 */

"use strict";

require("dotenv").config();

const { Telegraf } = require("telegraf");
const gameState = require("./gameState");
const actionRegistry = require("./roles/actionRegistry");
const dayVoting = require("./roles/dayVoting");
require("./commands/roles"); // ← add this

// ─────────────────────────────────────────────────────────────────────────────
// BOT INITIALISATION
// Discord equivalent: const client = new Discord.Client({ intents: [...] })
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
// Discord equivalent: client.commands = new Discord.Collection(); then fs.readdirSync(...)
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
];

for (const mod of commandModules) {
  commands.set(mod.name, mod);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 1 — GLOBAL ERROR BOUNDARY
// Ensures a single unhandled rejection in one update doesn't crash the bot.
// Discord equivalent: client.on("error", ...) / process.on("unhandledRejection", ...)
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error("Unhandled middleware error:", err);
    // Try to notify the chat if possible
    if (ctx.chat) {
      await ctx
        .reply("⚠️ An internal error occurred. Please try again.")
        .catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 2 — IGNORE BOTS
// Discord equivalent: if (message.author.bot) return;
// ─────────────────────────────────────────────────────────────────────────────

bot.use((ctx, next) => {
  if (ctx.from?.is_bot) return; // drop silently
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 3 — SILENCED PLAYER GATE (group chat only)
// Silenced players cannot speak in the group during their silenced round.
// Discord equivalent:
//   Discord applied a channel permission overwrite:
//     member.permissionOverwrites.create(channel, { SEND_MESSAGES: false })
//   In Telegram, bots cannot restrict specific members from sending messages.
//   Instead, we detect the message here and delete it, then notify the player.
//
// Only applies during the day phase (silencing takes effect the morning after).
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  // Only gate text messages in group chats during the day phase
  if (
    ctx.chat?.type !== "private" &&
    ctx.message?.text &&
    gameState.phase === "day"
  ) {
    const player = gameState.players.get(ctx.from.id);
    if (player?.silencedLastRound) {
      // Delete the message so others can't read it
      await ctx.deleteMessage().catch(() => {});
      // DM the silenced player to explain
      await bot.telegram
        .sendMessage(
          ctx.from.id,
          `🤫 <b>You are silenced today.</b>\n\n` +
            `The Mafia's Silencer visited you last night. ` +
            `You cannot speak at today's Town Hall meeting.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      return; // do not call next() — message is suppressed
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 4 — DEAD PLAYER GATE (group chat only)
// Dead players cannot send messages to the main game chat.
// Discord equivalent:
//   Dead players were moved to a "Ghost Town" voice channel and lost
//   permission to see/write in the Town Hall text channel.
//
// Same delete-and-DM approach as the silence gate.
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (
    ctx.chat?.type !== "private" &&
    ctx.message?.text &&
    gameState.isGameActive
  ) {
    const player = gameState.players.get(ctx.from.id);
    // Player is in the game but is dead
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
// ADD THESE TWO bot.command() BLOCKS ANYWHERE AFTER THE COMMAND DISPATCHER LOOP
// (before the action handlers)
// ─────────────────────────────────────────────────────────────────────────────

// /roles — send all 16 role cards grouped by alignment
bot.command("roles", async (ctx) => {
  const rolesCmd = commands.get("roles");
  await rolesCmd.execute(ctx, [], gameState, bot, "all");
});

// /role [name] — send the card for a single named role
bot.command("role", async (ctx) => {
  const rawText = ctx.message?.text ?? "";
  const args = rawText.trim().split(/\s+/).slice(1); // everything after /role
  const rolesCmd = commands.get("roles");
  await rolesCmd.execute(ctx, args, gameState, bot, "single");
});

// ─────────────────────────────────────────────────────────────────────────────
// /start — PRIVATE CHAT HANDLER
// Sent automatically when a user taps "Start" after clicking the bot's profile.
// Required so the bot can send that user DMs (Telegram requires a user to
// initiate a private conversation before a bot can message them).
//
// Discord equivalent: N/A — Discord bots can DM any guild member directly.
// This is the biggest DM limitation in Telegram and is why /setup sends a
// warning asking all players to tap Start first.
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") {
    // /start in a group — treat as /help
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

  // If a game setup is pending and this user is in the player list,
  // note that they've confirmed DM access (no state change needed —
  // setup will attempt their DM again once all players have confirmed).
  const player = gameState.players.get(userId);
  if (player) {
    console.log(`✅ DM confirmed: ${player.username} (${userId})`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND DISPATCHER
// Routes /commandName messages to the appropriate command module.
//
// Discord equivalent:
//   client.on("message", message => {
//     if (!message.content.startsWith(prefix)) return;
//     const commandName = ...;
//     const command = client.commands.get(commandName);
//     command.execute(message, args, gamedata);
//   })
//
// Key differences:
//   - Telegraf handles prefix parsing; we just hook bot.command()
//   - We pass (ctx, args, gameState, bot) instead of (message, args, gamedata)
//   - Commands that only work in DMs check ctx.chat.type === "private" themselves
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, cmd] of commands) {
  bot.command(name, async (ctx) => {
    // Extract args: everything after the command name, split by whitespace
    // Discord equivalent: args = message.content.slice(prefix.length).trim().split(/\s+/)
    const rawText = ctx.message?.text ?? "";
    const parts = rawText.trim().split(/\s+/);
    // parts[0] = "/commandName" or "/commandName@BotUsername" (in groups)
    const args = parts.slice(1);

    await cmd.execute(ctx, args, gameState, bot);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT ACTION CALLBACK HANDLER  (registered before day-vote handlers)
//
// Handles all night-prompt button presses from every role.
// Callback data format: "<prefix>:<round>:<actorId>:<value>"
// Prefixes: na, na_pi1, na_mayor, na_jailer, na_jailer_day
//
// Discord equivalent:
//   Each night prompt registered its own awaitReactions() closure.
//   Here we have ONE global handler routing into the actionRegistry.
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^na/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  // Parse: "<prefix>:<round>:<actorId>:<value>"
  const parts = data.split(":");
  if (parts.length < 4) return;

  const prefix = parts[0];
  const round = parts[1];
  const actorId = parts[2];
  const value = parts.slice(3).join(":");

  // Only the correct player can press their own buttons
  // Discord equivalent: awaitReactions filter: tuser.id === user.id
  if (String(ctx.from.id) !== actorId) {
    return ctx.answerCbQuery("⚠️ This isn't your prompt.").catch(() => {});
  }

  const key = `${prefix}:${round}:${actorId}`;
  const resolved = actionRegistry.resolve(key, value);

  if (resolved) {
    // Disable the keyboard to prevent double-presses
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  }
  // Stale press from a previous round — silently ignore
});

// ─────────────────────────────────────────────────────────────────────────────
// DAY NOMINATION VOTE HANDLER
//
// Callback data format: "vote_nom:<round>:<targetId>"
// voterId comes from ctx.from.id (not the callback data).
//
// Discord equivalent:
//   promptFilter = (reaction, tuser) => emojiMap.has(reaction.emoji.name) && tuser.id !== botId
//   prompt.awaitReactions(promptFilter, { time: dayTime * 1000 })
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_nom:/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (!ctx.callbackQuery?.data || !ctx.from) return;

  const parts = ctx.callbackQuery.data.split(":");
  if (parts.length < 3) return;

  const targetId = Number(parts[2]);
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  await dayVoting.receiveNominationVote(voterId, targetId, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// DAY EXECUTION VOTE HANDLER
//
// Callback data format: "vote_exec:<round>:<nomineeId>:<choice>"
// choice = "guilty" | "innocent"
//
// Discord equivalent:
//   votingPrompt.react("✅"); votingPrompt.react("❌");
//   votingPrompt.awaitReactions(votingFilter, { time: dayTime * 1000 })
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_exec:/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (!ctx.callbackQuery?.data || !ctx.from) return;

  const parts = ctx.callbackQuery.data.split(":");
  if (parts.length < 4) return;

  const choice = parts[3]; // "guilty" | "innocent"
  const voterId = ctx.from.id;

  if (ctx.from.is_bot) return;

  await dayVoting.receiveExecutionVote(voterId, choice, ctx, gameState, bot);
});

// ─────────────────────────────────────────────────────────────────────────────
// CATCH-ALL CALLBACK HANDLER
// Answers any unrecognised callback queries with a generic ack to prevent
// Telegram from showing a spinning loader on the button indefinitely.
// Discord equivalent: N/A
// ─────────────────────────────────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// Discord equivalent: client.destroy() inside process SIGINT handler.
// Clears all pending sessions/timers so the process exits cleanly.
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
// Discord equivalent: client.login(token)
// ─────────────────────────────────────────────────────────────────────────────

bot
  .launch()
  .then(() => {
    console.log(`✅ Mafiaville Bot is running.`);
    console.log(
      `   Admin IDs: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "(none)"}`,
    );
  })
  .catch((err) => {
    console.error("Fatal: failed to launch bot:", err);
    process.exit(1);
  });
