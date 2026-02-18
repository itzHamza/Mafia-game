/**
 * commands/erase.js
 * Telegram command: /erase <line number>  (DM only)
 * Discord equivalent: m.erase <line number>
 *
 * Discord → Telegram changes:
 *   message.channel.type === 'dm'  → ctx.chat.type === 'private'
 *   message.guild check            → ctx.chat.type !== 'private'
 *   gamedata.players.has(tag)      → gameState.players.has(ctx.from.id)
 *   player.will                    → player.lastWill
 *   message.channel.send(embed)    → ctx.reply(html)
 *
 * Bug note from original:
 *   Original threw Error() for args.length > 1 which was unhandled.
 *   Replaced with a friendly reply guiding correct usage.
 *
 * Will indexing:
 *   Original stored will lines as [lineNumber, text] tuples and re-indexed after splice.
 *   We store plain strings and render line numbers dynamically, so re-indexing is free.
 */

"use strict";

module.exports = {
  name: "erase",
  description:
    "Erase a line from your last will (use in bot DMs only). Usage: /erase <line number>",

  execute(ctx, args, gameState, bot) {
    const userId = ctx.from.id;

    // ── Guard: must be used in private/DM chat ───────────────────────────
    // Discord equivalent: if (message.guild) { ... }
    if (ctx.chat.type !== "private") {
      ctx.deleteMessage().catch(() => {});
      return ctx.reply(
        "🤫 Use /erase in our private DM to keep your will secret!",
        { parse_mode: "HTML" },
      );
    }

    // ── Guard: player must be in a game ──────────────────────────────────
    // Discord equivalent: if (gamedata.players.has(message.author.tag))
    if (!gameState.players.has(userId)) {
      return ctx.reply(
        "⚠️ You're not in any game — your will is already blank!",
      );
    }

    const player = gameState.players.get(userId);

    // ── Guard: will is already empty ─────────────────────────────────────
    if (player.lastWill.length === 0) {
      return ctx.reply("📜 Your last will is already empty.");
    }

    // ── Guard: correct argument format ───────────────────────────────────
    // Discord equivalent: if (args.length > 1) throw Error()
    // We handle it gracefully instead of throwing.
    if (args.length !== 1) {
      const willLines = player.lastWill
        .map((line, i) => `${i + 1}. ${line}`)
        .join("\n");
      return ctx.reply(
        "⚠️ Usage: <code>/erase &lt;line number&gt;</code>\n\n" +
          `Your current will:\n<pre>${escapeHtml(willLines)}</pre>`,
        { parse_mode: "HTML" },
      );
    }

    // ── Parse and validate the line number ───────────────────────────────
    const lineNum = parseInt(args[0], 10);

    if (isNaN(lineNum) || lineNum < 1) {
      return ctx.reply(
        "⚠️ Please provide a valid line number. Example: <code>/erase 2</code>",
        { parse_mode: "HTML" },
      );
    }

    // Discord equivalent: if (args[0] > player.will.length)
    if (lineNum > player.lastWill.length) {
      return ctx.reply(
        `⚠️ Line ${lineNum} doesn't exist. Your will only has ` +
          `<b>${player.lastWill.length}</b> line${player.lastWill.length !== 1 ? "s" : ""}.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Remove the line ───────────────────────────────────────────────────
    // Discord equivalent: player.will.splice(args[0] - 1, 1) + re-index loop
    // Since we store plain strings (not [number, text] tuples), no re-index needed.
    const removedLine = player.lastWill.splice(lineNum - 1, 1)[0];

    // ── Confirm and show updated will ─────────────────────────────────────
    // Discord equivalent: new Discord.MessageEmbed().setDescription(...)
    if (player.lastWill.length === 0) {
      return ctx.reply(
        `✂️ Removed line ${lineNum}: <i>${escapeHtml(removedLine)}</i>\n\n` +
          `📜 Your last will is now empty.`,
        { parse_mode: "HTML" },
      );
    }

    const willLines = player.lastWill
      .map((line, i) => `${i + 1}. ${line}`)
      .join("\n");

    ctx.reply(
      `✂️ Removed line ${lineNum}: <i>${escapeHtml(removedLine)}</i>\n\n` +
        `📜 <b>Your updated last will:</b>\n\n` +
        `<pre>${escapeHtml(willLines)}</pre>\n\n` +
        `Use /erase &lt;line number&gt; to remove another line.`,
      { parse_mode: "HTML" },
    );
  },
};

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
