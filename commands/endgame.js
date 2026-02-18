/**
 * commands/endgame.js
 * Telegram command: /endgame
 *
 * Force-terminates the current game immediately. Announces cause, reveals
 * all roles, resets state to lobby.
 *
 * Discord equivalent: no dedicated command existed — the bot relied on the
 * game loop completing naturally or the bot process being restarted.
 * This command is new functionality required in Telegram because:
 *   1. Telegram groups can't easily be wiped the way Discord channels could.
 *   2. Night-action Promises hold open timeouts that must be explicitly cleared.
 *   3. Inline keyboard sessions (voting) stay active unless explicitly ended.
 *
 * Clears in order:
 *   actionRegistry  → cancels pending night-prompt Promises / disables stale buttons
 *   dayVoting       → ends any active nomination or execution vote session
 *   gameState.reset → restores lobby state
 */

"use strict";

const actionRegistry = require("../roles/actionRegistry");
const { clearActiveSessions } = require("../roles/dayVoting");

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

module.exports = {
  name: "endgame",
  description: "Force-end the current game immediately (host or admin only).",

  async execute(ctx, args, gameState, bot) {
    // ── Guards ────────────────────────────────────────────────────────────
    if (ctx.chat.type === "private") {
      return ctx.reply("⚠️ This command must be used in the group chat.");
    }

    const issuerId = ctx.from.id;
    const issuer = gameState.players.get(issuerId);
    const isAllowed = ADMIN_IDS.includes(issuerId) || (issuer && issuer.isHost);

    if (!isAllowed) {
      return ctx.reply(
        "⚠️ Only the 👑 Host or an admin can force-end the game.",
      );
    }

    // Allow endgame in any phase except an empty lobby (nothing to end)
    if (gameState.phase === "lobby" && gameState.players.size === 0) {
      return ctx.reply("ℹ️ No game or lobby is currently active.");
    }

    const issuerName = issuer?.username ?? ctx.from.first_name ?? "Admin";

    await ctx.reply(`🛑 <b>${issuerName} has force-ended the game!</b>`, {
      parse_mode: "HTML",
    });

    // ── Cancel all pending async work ────────────────────────────────────
    // Night-action Promises are waiting on actionRegistry resolvers.
    // Clearing the registry causes those Promises to wait until their
    // individual timers fire — but since we're resetting state immediately,
    // any stale resolution will be a no-op (gameState.phase !== "night").
    actionRegistry.clear();

    // End any active voting sessions (releases their Promises immediately)
    clearActiveSessions();

    // ── Reveal all roles (if game was active) ─────────────────────────────
    if (gameState.players.size > 0) {
      const roleLines = Array.from(gameState.players.values())
        .map(
          (p) =>
            `<a href="tg://user?id=${p.id}">${p.username}</a>` +
            ` — <b>${p.role ?? "No role assigned"}</b>`,
        )
        .join("\n");

      await bot.telegram
        .sendMessage(ctx.chat.id, `📋 <b>Roles revealed:</b>\n\n${roleLines}`, {
          parse_mode: "HTML",
        })
        .catch(() => {});
    }

    // ── Reset ─────────────────────────────────────────────────────────────
    // Preserve the player list so they don't have to /join again.
    const prevPlayers = new Map(gameState.players);
    gameState.reset(prevPlayers);

    await bot.telegram
      .sendMessage(
        ctx.chat.id,
        `🔄 <b>The lobby is reset.</b>\n\nUse /setup to start a new game, ` +
          `or /leave to leave the lobby.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
  },
};
