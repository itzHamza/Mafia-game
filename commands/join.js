/**
 * commands/join.js
 * Telegram command: /join
 * Discord equivalent: m.join
 *
 * Discord → Telegram changes:
 *   message.author.tag          → ctx.from.id  (numeric ID; stable, unlike username)
 *   message.author.username     → ctx.from.first_name (display name for messages)
 *   message.author.id           → ctx.from.id
 *   gamedata.players.size === 0 → same logic, isHost flag on first joiner
 *   message.channel.send(embed) → ctx.reply(html, { parse_mode: 'HTML' })
 *   !message.guild              → ctx.chat.type === 'private'
 *   gamedata.userids Map        → gameState.userIds Map (id → username)
 *   embed.setThumbnail(avatar)  → DROPPED: Telegram bot can't reliably fetch user avatars inline
 */

"use strict";

module.exports = {
  name: "join",
  description: "Join the game lobby, or create one if none exists.",

  execute(ctx, args, gameState, bot) {
    // ── Guard: must be used in a group chat ──────────────────────────────
    // Discord equivalent: if (!message.guild)
    if (ctx.chat.type === "private") {
      return ctx.reply(
        "⚠️ You need to be in a <b>group chat</b> to join a game.",
        { parse_mode: "HTML" },
      );
    }

    const userId = ctx.from.id;
    // Use first_name + last_name if available, fall back to username or id string.
    // Discord used user.tag (username#discriminator) as the map key.
    // We use numeric userId as the map key — it never changes, unlike display names.
    const displayName = ctx.from.username
      ? `${ctx.from.first_name} (@${ctx.from.username})`
      : ctx.from.first_name;

    // ── Guard: already in the party ──────────────────────────────────────
    // Discord equivalent: if (gamedata.players.has(message.author.tag))
    if (gameState.players.has(userId)) {
      return ctx.reply(
        `<b>${ctx.from.first_name}</b> is already in the party.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Guard: game already running ──────────────────────────────────────
    // Discord equivalent: if (gamedata.gameActive)
    if (gameState.isGameActive) {
      return ctx.reply(
        "A game is already in progress. Please join after it ends.",
      );
    }

    // ── Register the player ──────────────────────────────────────────────
    // Discord equivalent:
    //   gamedata.players.set(message.author.tag, { id, username, role, ... })
    //   gamedata.userids.set(message.author.id, message.author.tag)
    const isHost = gameState.players.size === 0;

    gameState.players.set(userId, {
      id: userId,
      username: ctx.from.first_name, // short name used in game messages
      displayName, // full name with @handle for lobby display
      role: undefined,
      align: undefined,
      isAlive: true,
      isHost,
      distracted: false,
      wasFramed: false,
      silencedThisRound: false,
      silencedLastRound: false,
      lastWill: [], // renamed from 'will' for clarity
      roleMessage: undefined,
      vc: undefined, // kept for structural compat; unused in Telegram
      currentChannel: undefined, // kept for structural compat; unused
      mixerInput: undefined, // kept for structural compat; unused
    });

    // Reverse-lookup map: numeric id → first_name (mirrors gamedata.userids)
    gameState.userIds.set(userId, ctx.from.first_name);

    // ── Reply ────────────────────────────────────────────────────────────
    // Discord equivalent: new Discord.MessageEmbed().setTitle(...).setDescription(...)
    // Telegram uses HTML-formatted plain text instead of rich embeds.
    const hostNote = isHost ? "\n👑 You are the <b>Host</b>." : "";
    ctx.reply(
      `🃏 <b>${ctx.from.first_name}</b> has joined the game!${hostNote}\n` +
        `👥 Party size: <b>${gameState.players.size}</b>\n\n` +
        `Use /party to see who has joined.`,
      { parse_mode: "HTML" },
    );
  },
};
