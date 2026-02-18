/**
 * commands/leave.js
 * Telegram command: /leave
 * Discord equivalent: m.leave
 *
 * Discord → Telegram changes:
 *   message.author.tag                → ctx.from.id
 *   message.channel.type === 'dm'     → ctx.chat.type === 'private'
 *   gamedata.players.get(tag).isHost  → gameState.players.get(id).isHost
 *   gamedata.players.delete(tag)      → gameState.players.delete(id)
 *   gamedata.userids.delete(id)       → gameState.userIds.delete(id)
 *
 * Bug fixed from original:
 *   keys.length → Array.from(gameState.players.keys()).length  (ReferenceError in original)
 *
 * Behaviour change:
 *   Original had two hardcoded developer Discord tags given host priority.
 *   Replaced with a configurable ADMIN_IDS array read from .env so the pattern
 *   is preserved without hardcoded credentials.
 */

"use strict";

// Optional: comma-separated Telegram user IDs with host priority (like the original dev tags).
// Set ADMIN_IDS=123456789,987654321 in your .env file.
// Discord equivalent: let dev = ["PiAreSquared#6784", "8BitRobot#3625"]
const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

module.exports = {
  name: "leave",
  description: "Leave the active lobby.",

  execute(ctx, args, gameState, bot) {
    // ── Guard: DMs not allowed ───────────────────────────────────────────
    // Discord equivalent: if (message.channel.type === 'dm')
    if (ctx.chat.type === "private") {
      return ctx.reply("⚠️ This command must be used in the group chat.");
    }

    const userId = ctx.from.id;

    // ── Guard: not in the party ──────────────────────────────────────────
    if (!gameState.players.has(userId)) {
      return ctx.reply(`<b>${ctx.from.first_name}</b> is not in the party.`, {
        parse_mode: "HTML",
      });
    }

    // ── Guard: can't leave mid-game ──────────────────────────────────────
    // Discord equivalent: if (gamedata.gameActive)
    if (gameState.isGameActive) {
      return ctx.reply(
        "⚠️ Leaving mid-game is not allowed. Please wait until the current game ends.",
      );
    }

    const leavingPlayer = gameState.players.get(userId);
    const wasHost = leavingPlayer.isHost;

    // ── Remove the player ────────────────────────────────────────────────
    gameState.players.delete(userId);
    gameState.userIds.delete(userId);

    ctx.reply(
      `👋 <b>${ctx.from.first_name}</b> has left the party.\n` +
        `👥 Party size: <b>${gameState.players.size}</b>`,
      { parse_mode: "HTML" },
    );

    // ── Re-assign host if the host just left ─────────────────────────────
    // Discord equivalent: if (isHost) { ... reassign via dev priority list ... }
    if (!wasHost || gameState.players.size === 0) {
      return; // No host to reassign, or lobby is empty
    }

    // Priority 1: any admin-listed player still in the lobby
    // Discord equivalent: if (gamedata.players.has(dev[0])) { ... }
    const adminInLobby = ADMIN_IDS.find((id) => gameState.players.has(id));
    if (adminInLobby) {
      gameState.players.get(adminInLobby).isHost = true;
      const newHost = gameState.players.get(adminInLobby);
      return ctx.reply(`👑 <b>${newHost.username}</b> is now the Host.`, {
        parse_mode: "HTML",
      });
    }

    // Priority 2: pick the first remaining player at random
    // Bug fix: original used undefined variable `keys.length`
    const remainingIds = Array.from(gameState.players.keys());
    const newHostId =
      remainingIds[Math.floor(Math.random() * remainingIds.length)];
    gameState.players.get(newHostId).isHost = true;
    const newHost = gameState.players.get(newHostId);

    ctx.reply(`👑 <b>${newHost.username}</b> is now the Host.`, {
      parse_mode: "HTML",
    });
  },
};
