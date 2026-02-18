/**
 * commands/remove.js
 * Telegram command: /remove @username  OR  reply to a user's message + /remove
 * Discord equivalent: m.remove @username
 *
 * Discord → Telegram changes:
 *   args[0].replace('<@!', '').replace('>', '')  → Telegram mention parsing via entities
 *   message.author.tag permission check          → gameState host flag + ADMIN_IDS
 *   gamedata.userids.has(userid)                 → gameState.players.has(targetId)
 *   gamedata.players.delete(tag)                 → gameState.players.delete(targetId)
 *   gamedata.userids.delete(userid)              → gameState.userIds.delete(targetId)
 *
 * Telegram mention handling:
 *   In Telegram, @username mentions arrive as message entities with type 'mention'.
 *   text_mention entities carry the full user object (for users without @usernames).
 *   We check both, plus allow replying to a user's message as an alternative.
 *
 * Bugs fixed from original:
 *   'messahe' typo → 'message' (now ctx.message)
 *   'gamedata.userids,get(userid)' comma typo → dot
 *   Missing return after permission error guard
 */

"use strict";

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

module.exports = {
  name: "remove",
  description:
    "Remove a player from the lobby (host only). Usage: /remove @username or reply to their message.",

  execute(ctx, args, gameState, bot) {
    // ── Guard: DMs not allowed ───────────────────────────────────────────
    if (ctx.chat.type === "private") {
      return ctx.reply("⚠️ This command must be used in the group chat.");
    }

    const issuerId = ctx.from.id;
    const issuer = gameState.players.get(issuerId);

    // ── Guard: only host or admin can remove ─────────────────────────────
    // Discord equivalent:
    //   if (!gamedata.players.get(message.author.tag).isHost
    //     && message.author.tag !== "PiAreSquared#6784" ...)
    const isAuthorized =
      (issuer && issuer.isHost) || ADMIN_IDS.includes(issuerId);

    if (!isAuthorized) {
      return ctx.reply(
        `⚠️ <b>${ctx.from.first_name}</b> does not have permission to remove players.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Guard: can't remove mid-game ─────────────────────────────────────
    // Discord equivalent: if (gamedata.gameActive)
    if (gameState.isGameActive) {
      return ctx.reply("⚠️ Removing players mid-game is not allowed.");
    }

    // ── Resolve the target player ────────────────────────────────────────
    // Telegram has two ways to target someone:
    //   1. Reply to one of their messages → ctx.message.reply_to_message.from
    //   2. @mention in the command text   → ctx.message.entities of type 'mention'
    //
    // Discord equivalent: args[0].replace('<@!', '').replace('>', '') → userId string
    let targetId = null;
    let targetName = null;

    // Method 1: replying to a message
    const replyTo = ctx.message.reply_to_message;
    if (replyTo && replyTo.from) {
      targetId = replyTo.from.id;
      targetName = replyTo.from.first_name;
    }

    // Method 2: @mention in the command (overrides reply if both present)
    const entities = ctx.message.entities ?? [];
    for (const entity of entities) {
      if (entity.type === "text_mention" && entity.user) {
        // text_mention: user has no public @username; user object is embedded
        targetId = entity.user.id;
        targetName = entity.user.first_name;
        break;
      }
      if (entity.type === "mention") {
        // @username mention — we look up by username in our players map
        const mentionText = ctx.message.text.substring(
          entity.offset + 1, // skip the '@'
          entity.offset + entity.length,
        );
        // Find the player whose Telegram @username matches
        for (const [id, player] of gameState.players) {
          if (
            player.displayName &&
            player.displayName.toLowerCase().includes(mentionText.toLowerCase())
          ) {
            targetId = id;
            targetName = player.username;
            break;
          }
        }
        break;
      }
    }

    // ── Guard: could not resolve a target ────────────────────────────────
    if (!targetId) {
      return ctx.reply(
        "⚠️ Couldn't identify who to remove.\n" +
          "Usage: Reply to their message and type /remove, or use /remove @username.",
      );
    }

    // ── Guard: removing yourself ─────────────────────────────────────────
    // Discord equivalent: else if (message.author.username === gamedata.userids.get(userid).slice(0,-5))
    if (targetId === issuerId) {
      return ctx.reply("⚠️ Use /leave to remove yourself from the party.");
    }

    // ── Guard: target not in lobby ───────────────────────────────────────
    // Discord equivalent: gamedata.userids.has(userid) check
    if (!gameState.players.has(targetId)) {
      return ctx.reply(
        `⚠️ <b>${targetName ?? "That user"}</b> is not in the party.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Remove the player ────────────────────────────────────────────────
    // Discord equivalent:
    //   gamedata.players.delete(gamedata.userids.get(userid))
    //   gamedata.userids.delete(userid)
    const removedPlayer = gameState.players.get(targetId);
    gameState.players.delete(targetId);
    gameState.userIds.delete(targetId);

    ctx.reply(
      `🚫 <b>${removedPlayer.username}</b> has been removed from the party.\n` +
        `👥 Party size: <b>${gameState.players.size}</b>`,
      { parse_mode: "HTML" },
    );
  },
};
