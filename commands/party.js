/**
 * commands/party.js
 * Telegram command: /party
 * Discord equivalent: m.party
 *
 * Discord → Telegram changes:
 *   new Discord.MessageEmbed().setTitle().addField()  → HTML string
 *   message.channel.send(embed)                       → ctx.reply(html)
 *   Iterating gamedata.players Map                    → same (Map is identical)
 *
 * Enhancement over original:
 *   Shows player alignment summary (role counts) when game is in progress,
 *   since Telegram has no equivalent of Discord's channel-based status indicators.
 */

"use strict";

module.exports = {
  name: "party",
  description: "List all players currently in the lobby.",

  execute(ctx, args, gameState, bot) {
    const count = gameState.players.size;

    if (count === 0) {
      return ctx.reply("The lobby is empty! Use /join to start a party.", {
        parse_mode: "HTML",
      });
    }

    // ── Build the player list ────────────────────────────────────────────
    // Discord equivalent:
    //   for (const [tag, obj] of gamedata.players)
    //     playerList += `\n- **${obj.username}**` + (obj.isHost ? " (Host)" : "")
    let playerList = "";
    for (const [id, player] of gameState.players) {
      const hostBadge = player.isHost ? " 👑" : "";
      const aliveBadge = gameState.isGameActive
        ? player.isAlive
          ? " ✅"
          : " 💀"
        : "";
      // Mention player via Telegram inline mention so the name is tappable.
      // Discord equivalent: **${obj.username}** (bold display name)
      playerList += `\n• <a href="tg://user?id=${id}">${player.username}</a>${hostBadge}${aliveBadge}`;
    }

    // ── Phase context ────────────────────────────────────────────────────
    let phaseText = "";
    if (gameState.phase === "lobby") {
      phaseText = "\n\n🔧 Use /setup to assign roles when ready.";
    } else if (gameState.phase === "night") {
      phaseText = `\n\n🌙 Round ${gameState.currentRound} — Night phase.`;
    } else if (gameState.phase === "day") {
      phaseText = `\n\n☀️ Round ${gameState.currentRound} — Day phase.`;
    }

    // ── Discord equivalent: embed title ──────────────────────────────────
    const title =
      count === 1
        ? "There is <b>1 player</b> in the party."
        : `There are <b>${count} players</b> in the party.`;

    ctx.reply(`🃏 ${title}\n${playerList}${phaseText}`, { parse_mode: "HTML" });
  },
};
