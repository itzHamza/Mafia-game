/**
 * commands/join.js — DEBUG BUILD
 */

"use strict";

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}
function log(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}
function warn(tag, msg) {
  console.warn(`[${ts()}] [${tag}] ⚠️  ${msg}`);
}

module.exports = {
  name: "join",
  description: "Join the game lobby, or create one if none exists.",

  execute(ctx, args, gameState, bot) {
    const userId = ctx.from.id;
    log(
      "JOIN",
      `from=${userId} chatType=${ctx.chat.type} currentPlayers=${gameState.players.size}`,
    );

    if (ctx.chat.type === "private") {
      warn("JOIN", `Rejected — private chat from=${userId}`);
      return ctx.reply(
        "⚠️ You need to be in a <b>group chat</b> to join a game.",
        { parse_mode: "HTML" },
      );
    }

    const displayName = ctx.from.username
      ? `${ctx.from.first_name} (@${ctx.from.username})`
      : ctx.from.first_name;

    if (gameState.players.has(userId)) {
      warn("JOIN", `Already in party: userId=${userId}`);
      return ctx.reply(
        `<b>${ctx.from.first_name}</b> is already in the party.`,
        { parse_mode: "HTML" },
      );
    }

    if (gameState.isGameActive) {
      warn("JOIN", `Rejected — game active: userId=${userId}`);
      return ctx.reply(
        "A game is already in progress. Please join after it ends.",
      );
    }

    const isHost = gameState.players.size === 0;
    gameState.players.set(userId, {
      id: userId,
      username: ctx.from.first_name,
      displayName,
      role: undefined,
      align: undefined,
      isAlive: true,
      isHost,
      distracted: false,
      wasFramed: false,
      silencedThisRound: false,
      silencedLastRound: false,
      lastWill: [],
      roleMessage: undefined,
      vc: undefined,
      currentChannel: undefined,
      mixerInput: undefined,
    });

    gameState.userIds.set(userId, ctx.from.first_name);

    log(
      "JOIN",
      `SUCCESS userId=${userId} username=${ctx.from.first_name} isHost=${isHost} partySize=${gameState.players.size}`,
    );

    const hostNote = isHost ? "\n👑 You are the <b>Host</b>." : "";
    ctx.reply(
      `🃏 <b>${ctx.from.first_name}</b> has joined the game!${hostNote}\n👥 Party size: <b>${gameState.players.size}</b>`,
      { parse_mode: "HTML" },
    );
  },
};
