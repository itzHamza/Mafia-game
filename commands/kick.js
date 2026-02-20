/**
 * commands/kick.js
 * Telegram command: /kick @player  (or reply to a message)
 *
 * Removes a player mid-game or from the lobby.
 * Discord equivalent: no dedicated kick command existed — the bot used
 * Discord's member.kick() API. Here we just remove from state (we have
 * no API to remove a Telegram user from a group).
 *
 * Mid-game behaviour:
 *   • Marks the player as dead, removes from playersAlive.
 *   • Silently — no death announcement to preserve information symmetry.
 *   • If the kicked player is Mafia, triggers Godfather succession check.
 *   • If the kicked player is the Jailer and had a prisoner, releases the prisoner.
 *   • Does NOT add to deadThisRound (no role reveal).
 *
 * Lobby behaviour:
 *   • Identical to /remove — removes player and reassigns host if needed.
 */

"use strict";

const { notifyGodfatherSuccession } = require("../roles/nightResolver");

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

module.exports = {
  name: "kick",
  description: "Kick a player from the lobby or mid-game (host or admin only).",

  async execute(ctx, args, gameState, bot) {
    if (ctx.chat.type === "private") {
      return ctx.reply("⚠️ This command must be used in the group chat.");
    }

    const issuerId = ctx.from.id;
    const issuer = gameState.players.get(issuerId);
    const isAllowed = ADMIN_IDS.includes(issuerId) || (issuer && issuer.isHost);

    if (!isAllowed) {
      ctx.deleteMessage().catch(() => { });
      return;
    }

    // ── Resolve target ────────────────────────────────────────────────────
    // Same dual-mode resolution used in /remove (Phase 2):
    //   Mode A: reply to target's message
    //   Mode B: @username or text_mention in command args
    let targetId = null;
    let targetName = null;

    const reply = ctx.message?.reply_to_message;
    if (reply?.from && !reply.from.is_bot) {
      targetId = reply.from.id;
      targetName = reply.from.first_name;
    } else {
      const entities = ctx.message?.entities ?? [];
      for (const entity of entities) {
        if (entity.type === "mention") {
          const handle = ctx.message.text
            .slice(entity.offset + 1, entity.offset + entity.length)
            .toLowerCase();
          for (const [uid, p] of gameState.players) {
            if ((p.username ?? "").toLowerCase() === handle) {
              targetId = uid;
              targetName = p.username;
              break;
            }
          }
        } else if (entity.type === "text_mention" && entity.user) {
          targetId = entity.user.id;
          targetName = entity.user.first_name;
        }
        if (targetId) break;
      }
    }

    if (!targetId || !gameState.players.has(targetId)) {
      return ctx.reply(
        "⚠️ Player not found.\n\n" +
          "Usage: <code>/kick @username</code> or reply to their message.",
        { parse_mode: "HTML" },
      );
    }

    // Cannot kick yourself
    if (targetId === issuerId) {
      return ctx.reply("⚠️ You cannot kick yourself.");
    }

    const target = gameState.players.get(targetId);

    // ── Mid-game kick ─────────────────────────────────────────────────────
    if (gameState.isGameActive) {
      if (!target.isAlive) {
        return ctx.reply(`⚠️ ${target.username} is already dead.`);
      }

      // Mark dead
      target.isAlive = false;
      gameState.players.set(targetId, target);
      gameState.playersAlive = gameState.playersAlive.filter(
        (id) => id !== targetId,
      );

      // Release Jailer prisoner if the kicked player was jailed
      if (gameState.roleState.Jailer.lastSelection === targetId) {
        gameState.roleState.Jailer.lastSelection = null;
      }

      // Release Jailer if they're the one being kicked
      if (gameState.roleState.Jailer.jailerId === targetId) {
        gameState.roleState.Jailer.lastSelection = null;
      }

      // Remove from alignment arrays
      gameState.mafiaPlayers = gameState.mafiaPlayers.filter(
        (id) => id !== targetId,
      );
      gameState.villagePlayers = gameState.villagePlayers.filter(
        (id) => id !== targetId,
      );
      gameState.neutralPlayers = gameState.neutralPlayers.filter(
        (id) => id !== targetId,
      );

      // Godfather succession if a Mafia member was kicked
      if (target.align === "Mafia") {
        // Remove from currentMafia map
        for (const [role, uid] of Object.entries(gameState.currentMafia)) {
          if (uid === targetId) delete gameState.currentMafia[role];
        }
        await notifyGodfatherSuccession(bot, gameState);
      }

      // Notify the kicked player by DM
      await bot.telegram
        .sendMessage(
          targetId,
          `🥾 <b>You have been removed from the game by the host.</b>\n\n` +
            `You may stay in the group chat but please don't reveal game information.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      return ctx.reply(
        `🥾 <b>${target.username}</b> has been removed from the game.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Lobby kick (same as /remove) ──────────────────────────────────────
    const wasHost = target.isHost;
    const issuerName = issuer?.username ?? "Admin";

    gameState.players.delete(targetId);
    gameState.userIds.delete(targetId);

    let hostNotice = "";
    if (wasHost) {
      // Transfer host to an admin if available, otherwise first remaining player
      const adminInGame = Array.from(gameState.players.keys()).find((id) =>
        ADMIN_IDS.includes(id),
      );
      const newHostId =
        adminInGame ??
        (gameState.players.size > 0
          ? Array.from(gameState.players.keys())[0]
          : null);

      if (newHostId) {
        const newHost = gameState.players.get(newHostId);
        newHost.isHost = true;
        gameState.players.set(newHostId, newHost);
        hostNotice = ` 👑 ${newHost.username} is the new host.`;

        await bot.telegram
          .sendMessage(
            newHostId,
            `👑 <b>You are now the host!</b> The previous host was removed.`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
    }

    await ctx.reply(
      `🥾 <b>${target.username}</b> was kicked from the lobby by ${issuerName}.${hostNotice}`,
      { parse_mode: "HTML" },
    );

    await bot.telegram
      .sendMessage(
        targetId,
        `🥾 <b>You were removed from the lobby by the host.</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
  },
};
