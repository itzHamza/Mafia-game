/**
 * commands/settings.js
 * Telegram command: /settings [key] [value]
 *
 * View or change game settings. Host/admin only.
 *
 * Discord equivalent: no equivalent — settings were hardcoded constants
 * in start.js (nightTime, dayTime, etc.).
 *
 * Usage examples:
 *   /settings                     → show current settings
 *   /settings nighttime 90        → set night phase to 90 seconds
 *   /settings daytime 150
 *   /settings votingtime 45
 *   /settings mafiahidden true
 *   /settings mafiahidden false
 */

"use strict";

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

/** Bounds for numeric settings */
const BOUNDS = {
  nightTime: { min: 20, max: 300 },
  dayTime: { min: 30, max: 600 },
  votingTime: { min: 10, max: 120 },
};

/** Map raw CLI keys → internal setting names */
const KEY_MAP = {
  nighttime: "nightTime",
  daytime: "dayTime",
  votingtime: "votingTime",
  mafiahidden: "mafiaHidden",
  night: "nightTime",
  day: "dayTime",
  voting: "votingTime",
};

function buildSettingsText(settings) {
  const hiddenLabel = settings.mafiaHidden ? "✅ on" : "❌ off";
  return (
    `⚙️ <b>Current settings</b>\n\n` +
    `<b>nighttime</b>    — ${settings.nightTime}s  (range: 20–300)\n` +
    `<b>daytime</b>      — ${settings.dayTime}s  (range: 30–600)\n` +
    `<b>votingtime</b>   — ${settings.votingTime}s  (range: 10–120)\n` +
    `<b>mafiahidden</b>  — ${hiddenLabel}  (reduces player threshold for extra Mafia)\n\n` +
    `Usage: <code>/settings nighttime 90</code>`
  );
}

module.exports = {
  name: "settings",
  description: "View or change game settings (host or admin only).",

  async execute(ctx, args, gameState, bot) {
    if (ctx.chat.type === "private") {
      return ctx.reply("⚠️ This command must be used in the group chat.");
    }

    const issuerId = ctx.from.id;
    const issuer = gameState.players.get(issuerId);
    const isAllowed = ADMIN_IDS.includes(issuerId) || (issuer && issuer.isHost);

    if (!isAllowed) {
      return ctx.reply("⚠️ Only the 👑 Host or an admin can change settings.");
    }

    if (gameState.isGameActive) {
      return ctx.reply("⚠️ Settings cannot be changed during an active game.");
    }

    // ── No args → show current ────────────────────────────────────────────
    if (!args || args.length === 0) {
      return ctx.reply(buildSettingsText(gameState.settings), {
        parse_mode: "HTML",
      });
    }

    // ── Parse key/value pair ──────────────────────────────────────────────
    const rawKey = args[0].toLowerCase().replace(/[^a-z]/g, "");
    const key = KEY_MAP[rawKey];

    if (!key) {
      return ctx.reply(
        `⚠️ Unknown setting: <code>${args[0]}</code>\n\n` +
          buildSettingsText(gameState.settings),
        { parse_mode: "HTML" },
      );
    }

    if (args.length < 2) {
      return ctx.reply(
        `⚠️ Please provide a value.\nExample: <code>/settings ${rawKey} 90</code>`,
        { parse_mode: "HTML" },
      );
    }

    const rawValue = args[1].toLowerCase();

    // ── Boolean setting ───────────────────────────────────────────────────
    if (key === "mafiaHidden") {
      if (!["true", "false", "on", "off", "1", "0"].includes(rawValue)) {
        return ctx.reply(
          "⚠️ Value must be <code>true</code> or <code>false</code>.",
          { parse_mode: "HTML" },
        );
      }
      gameState.settings.mafiaHidden = ["true", "on", "1"].includes(rawValue);
      return ctx.reply(
        `✅ <b>mafiahidden</b> set to <b>${gameState.settings.mafiaHidden}</b>.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Numeric setting ───────────────────────────────────────────────────
    const num = parseInt(rawValue, 10);
    const bounds = BOUNDS[key];

    if (isNaN(num)) {
      return ctx.reply(
        `⚠️ Value must be a number. Example: <code>/settings ${rawKey} 90</code>`,
        { parse_mode: "HTML" },
      );
    }
    if (num < bounds.min || num > bounds.max) {
      return ctx.reply(
        `⚠️ <b>${key}</b> must be between <b>${bounds.min}</b> and <b>${bounds.max}</b>.`,
        { parse_mode: "HTML" },
      );
    }

    gameState.settings[key] = num;
    return ctx.reply(`✅ <b>${key}</b> set to <b>${num}s</b>.`, {
      parse_mode: "HTML",
    });
  },
};
