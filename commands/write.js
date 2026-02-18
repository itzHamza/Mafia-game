/**
 * commands/write.js
 * Telegram command: /write <text>  (DM only)
 * Discord equivalent: m.write <text>
 *
 * Discord → Telegram changes:
 *   message.guild check               → ctx.chat.type !== 'private'
 *   message.channel.type === 'dm'     → ctx.chat.type === 'private'
 *   gamedata.players.has(author.tag)  → gameState.players.has(ctx.from.id)
 *   player.will                       → player.lastWill  (renamed for clarity)
 *   message.channel.send(embed)       → ctx.reply(html)
 *   message.delete()                  → ctx.deleteMessage() (group message attempt)
 *
 * Behaviour note:
 *   In Discord, m.write sent in a public channel was deleted and the user warned.
 *   In Telegram, bots can only delete their OWN messages in groups unless they
 *   are admin. We attempt deletion but catch the error gracefully, and warn the
 *   user via the group chat without revealing the will content.
 *
 * Args handling:
 *   Discord original captured full raw text after prefix in one string.
 *   Here, args array is joined back with spaces to reconstruct the sentence.
 */

"use strict";

const MAX_WILL_LINE_LENGTH = 300;
const MAX_WILL_LINES = 20; // Reasonable cap not in original; avoids message truncation

module.exports = {
  name: "write",
  description: "Add a line to your last will (use in bot DMs only).",

  execute(ctx, args, gameState, bot) {
    const userId = ctx.from.id;

    // ── Guard: player must be in a game ──────────────────────────────────
    // Discord equivalent: if (gamedata.players.has(message.author.tag))
    if (!gameState.players.has(userId)) {
      return ctx.reply(
        "⚠️ You can't write a last will unless you're part of a game!\n" +
          "Join the group chat and use /join first.",
      );
    }

    // ── Guard: must be used in private/DM chat ───────────────────────────
    // Discord equivalent:
    //   if (message.guild) { message.channel.send("Keep your role a secret."); message.delete(); }
    if (ctx.chat.type !== "private") {
      // Attempt to delete the message to protect the player's secrecy.
      // Will silently fail if the bot isn't an admin in the group — that's fine.
      ctx.deleteMessage().catch(() => {});

      // Warn in the group without revealing content
      ctx.reply(
        `🤫 <b>${ctx.from.first_name}</b>, don't write your will here!\n` +
          `Send me a <b>private message</b> to keep your role secret: use /write in our DM.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // ── Guard: must have content ─────────────────────────────────────────
    // Discord equivalent: args (the raw trimmed string after prefix)
    // We join the args array back since the loader splits on whitespace.
    const willText = args.join(" ").trim();

    if (!willText) {
      return ctx.reply(
        "⚠️ Usage: <code>/write your message here</code>\n" +
          "Example: <code>/write I think the Godfather is Alex.</code>",
        { parse_mode: "HTML" },
      );
    }

    // ── Guard: line length cap ───────────────────────────────────────────
    // Discord equivalent: if (args.length > 300)
    if (willText.length > MAX_WILL_LINE_LENGTH) {
      return ctx.reply(
        `⚠️ Keep each line under ${MAX_WILL_LINE_LENGTH} characters. ` +
          `Your line was ${willText.length} characters.`,
      );
    }

    const player = gameState.players.get(userId);

    // ── Guard: will line count cap ───────────────────────────────────────
    if (player.lastWill.length >= MAX_WILL_LINES) {
      return ctx.reply(
        `⚠️ Your will already has ${MAX_WILL_LINES} lines. ` +
          `Use /erase <line number> to remove an entry first.`,
      );
    }

    // ── Append to the will ───────────────────────────────────────────────
    // Discord equivalent: player.will.push([player.will.length + 1, args])
    // We store as a plain string (line text only); line numbers are rendered dynamically.
    player.lastWill.push(willText);

    // ── Format and display the full will ─────────────────────────────────
    // Discord equivalent: new Discord.MessageEmbed().setDescription(...)
    const willLines = player.lastWill
      .map((line, i) => `${i + 1}. ${line}`)
      .join("\n");

    ctx.reply(
      `📜 <b>Your last will has been updated:</b>\n\n` +
        `<pre>${escapeHtml(willLines)}</pre>\n\n` +
        `Use /erase &lt;line number&gt; to remove a line.`,
      { parse_mode: "HTML" },
    );
  },
};

/**
 * Escape HTML special characters for safe insertion into HTML parse_mode messages.
 * Needed when user-provided text is wrapped in <pre> tags.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
