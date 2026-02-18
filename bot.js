/**
 * bot.js
 * Entry point for the Mafiaville Telegram Mafia Bot.
 *
 * Discord.js equivalent concepts replaced here:
 *   new Discord.Client()         → new Telegraf(token)
 *   client.login(token)          → bot.launch()
 *   client.once('ready')         → bot.launch().then(...)
 *   client.on('message')         → bot.on('text') / bot.command()
 *   new Discord.Intents()        → NOT NEEDED (Telegraf has no intents)
 *   spectatorClient (voice bot)  → DROPPED (no voice API in Telegram)
 *   AudioMixer / stream          → DROPPED (no voice relay in Telegram)
 *   client.on('voiceStateUpdate') → DROPPED
 */

"use strict";

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const gameState = require("./gameState");

// ─────────────────────────────────────────────────────────────────────────────
// BOT INITIALISATION
// Discord equivalent: new Discord.Client({ intents }) + client.login(token)
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.BOT_TOKEN) {
  console.error("❌  BOT_TOKEN is missing. Add it to your .env file.");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL MIDDLEWARE
// Discord equivalent: client.on('message') pre-processing guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logging middleware — logs every incoming update to the console.
 * Equivalent to Discord's console.log on message receipt.
 */
bot.use(async (ctx, next) => {
  const user = ctx.from
    ? `${ctx.from.first_name} (id:${ctx.from.id})`
    : "unknown";
  const text = ctx.message?.text ?? ctx.callbackQuery?.data ?? "[non-text]";
  console.log(`[${new Date().toISOString()}] ${user}: ${text}`);
  return next();
});

/**
 * Group chat guard middleware.
 * Records the group chat ID the first time any command arrives from a group.
 * Discord equivalent: message.guild check + storing guild context in gamedata.
 */
bot.use(async (ctx, next) => {
  if (
    ctx.chat &&
    (ctx.chat.type === "group" || ctx.chat.type === "supergroup") &&
    !gameState.groupChatId
  ) {
    gameState.groupChatId = ctx.chat.id;
    console.log(`📌 Group chat registered: ${gameState.groupChatId}`);
  }
  return next();
});

/**
 * Silenced player middleware.
 * Discord equivalent: channel.updateOverwrite(user, { SEND_MESSAGES: false })
 *
 * Since Telegram bots cannot restrict individual users from sending messages,
 * we simply ignore commands from silenced players during the day phase.
 * The player's message still appears in the chat — we just don't act on it.
 */
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const player = gameState.getPlayer(ctx.from.id);
  if (
    player &&
    player.silencedThisRound &&
    gameState.phase === "day" &&
    ctx.chat?.type !== "private"
  ) {
    // Silently drop — player is silenced this round
    return;
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER LOADER
// Discord equivalent: fs.readdirSync('./commands') + client.commands Collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dynamically load all command modules from the /commands directory.
 * Each command file must export: { name: string, execute: Function }
 *
 * Discord equivalent: client.commands = new Discord.Collection()
 * We use a plain Map here — no need for Discord.Collection.
 */
const commands = new Map();
const commandsPath = path.join(__dirname, "commands");

// Only load if the commands directory exists (safe for initial scaffold)
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (!command.name || typeof command.execute !== "function") {
      console.warn(`⚠️  Skipping ${file}: missing name or execute()`);
      continue;
    }
    commands.set(command.name, command);

    // Register the command with Telegraf so it responds to /commandName
    // Discord equivalent: client.commands.get(command).execute(message, args, gamedata)
    bot.command(command.name, (ctx) => {
      // Parse args from the message text, stripping the /command prefix
      // Discord equivalent: args = message.content.substring(prefix.length).trim().split(/ +/)
      const rawText = ctx.message?.text ?? "";
      const args = rawText
        .substring(rawText.indexOf(" ") + 1)
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      try {
        command.execute(ctx, args, gameState, bot);
      } catch (error) {
        console.error(`Error in command /${command.name}:`, error);
        ctx.reply("⚠️ An error occurred running that command.").catch(() => {});
      }
    });

    console.log(`✅  Loaded command: /${command.name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CALLBACK QUERY HANDLER (inline keyboard button presses)
// Discord equivalent: prompt.awaitReactions(filter, { time }) + reaction events
//
// In Discord, role prompts used message reactions as a voting/selection UI.
// In Telegram, we use inline keyboard buttons. Button presses fire callback
// queries which are handled here and routed to the appropriate game handler.
//
// Callback data format convention (used throughout the ported role logic):
//   "<action_namespace>:<round>:<actorId>:<payload>"
// Example: "night_action:1:123456789:Detective"
// ─────────────────────────────────────────────────────────────────────────────

// ── PLACEHOLDER: night action responses ──────────────────────────────────────
// TODO (Phase 4): Route night action button presses to role handlers
// Each role's prompt() will register a specific action namespace
bot.action(/^night_action:/, async (ctx) => {
  await ctx.answerCbQuery(); // Always acknowledge to remove the loading spinner
  const data = ctx.callbackQuery.data;
  // TODO: parse data, validate actor, record in gameState.nightActions
  console.log(`Night action callback: ${data}`);
});

// ── PLACEHOLDER: day vote — nomination ───────────────────────────────────────
// TODO (Phase 5): Handle nomination votes during the day phase
bot.action(/^nominate:/, async (ctx) => {
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  // TODO: parse data, tally vote in gameState.votes, check threshold
  console.log(`Nomination vote callback: ${data}`);
});

// ── PLACEHOLDER: day vote — guilty/innocent ──────────────────────────────────
// TODO (Phase 5): Handle execution votes after a player is nominated
bot.action(/^execute_vote:/, async (ctx) => {
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  // TODO: parse data, tally yay/nay, resolve execution
  console.log(`Execution vote callback: ${data}`);
});

// ── PLACEHOLDER: mayor reveal ────────────────────────────────────────────────
// TODO (Phase 4): Handle Mayor's decision to reveal during the night prompt
bot.action(/^mayor_reveal:/, async (ctx) => {
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  // TODO: set gameState.mayor, push mayor-reveal to deadThisRound log
  console.log(`Mayor reveal callback: ${data}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT MESSAGE HANDLER
// Discord equivalent: message.channel.type === 'dm' guard in write.js / erase.js
//
// In Discord, last-will commands were DM-only for secrecy.
// We preserve this pattern — /write and /erase only work in private chats.
// The commands themselves enforce this; this handler is just for context logging.
// ─────────────────────────────────────────────────────────────────────────────

bot.on("text", async (ctx, next) => {
  // Only log private chat non-command messages; commands are handled above
  if (ctx.chat.type === "private" && !ctx.message.text.startsWith("/")) {
    console.log(`DM from ${ctx.from.first_name}: ${ctx.message.text}`);
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION / SCENE SETUP PLACEHOLDER
// Discord equivalent: N/A (Discord had no built-in session; we used closures)
//
// TODO (Phase 4, if needed): Add telegraf-scenes or session middleware here
// if role prompts require multi-step conversation flows (e.g. Jailer kill confirm).
// Currently all prompts are handled via single inline keyboard + bot.action().
// ─────────────────────────────────────────────────────────────────────────────
// import { session } from 'telegraf'       ← uncomment if scenes are needed
// import { Stage, WizardScene } from 'telegraf/scenes'
// bot.use(session());
// bot.use(stage.middleware());

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: Send a message to a specific chat by ID
// Discord equivalent: message.guild.channels.resolve(id).send(embed)
//
// Usage: sendTo(chatId, 'Hello!') or sendTo(userId, 'Private message')
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a plain or HTML-formatted message to any chat or user by ID.
 * Export this for use in command/game files.
 *
 * @param {number} chatId - Telegram chat ID or user ID
 * @param {string} text   - Message text (HTML supported)
 * @param {object} [extra] - Optional Telegraf extra (e.g. inline keyboard)
 * @returns {Promise}
 */
function sendTo(chatId, text, extra = {}) {
  return bot.telegram.sendMessage(chatId, text, {
    parse_mode: "HTML",
    ...extra,
  });
}

/**
 * Send a photo to any chat or user by ID.
 * Discord equivalent: embed.attachFiles(['images/x.png']).setImage(...)
 *
 * @param {number} chatId
 * @param {string} imagePath - Local file path, e.g. 'images/godfather.png'
 * @param {string} [caption]
 * @returns {Promise}
 */
function sendImageTo(chatId, imagePath, caption = "") {
  return bot.telegram.sendPhoto(
    chatId,
    { source: fs.createReadStream(imagePath) },
    { caption, parse_mode: "HTML" },
  );
}

module.exports.sendTo = sendTo;
module.exports.sendImageTo = sendImageTo;

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH
// Discord equivalent: client.login(config.token)
// ─────────────────────────────────────────────────────────────────────────────

bot
  .launch()
  .then(() => {
    console.log("🎲 Mafiaville Bot is online and ready!");
    console.log(
      `📋 Loaded ${commands.size} command(s): ${[...commands.keys()].map((c) => `/${c}`).join(", ")}`,
    );
  })
  .catch((err) => {
    console.error("❌ Failed to launch bot:", err);
    process.exit(1);
  });

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// Discord equivalent: N/A (Discord bots just killed the process)
// Telegraf provides bot.stop() which cleanly closes the polling connection.
// ─────────────────────────────────────────────────────────────────────────────

process.once("SIGINT", () => {
  console.log("\n🛑 SIGINT received — shutting down gracefully...");
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  console.log("\n🛑 SIGTERM received — shutting down gracefully...");
  bot.stop("SIGTERM");
});
