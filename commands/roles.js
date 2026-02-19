/**
 * commands/roles.js
 * Telegram commands: /roles | /role [name]
 *
 * /roles        → sends all 16 role cards grouped by alignment
 * /role [name]  → sends the card for one specific role
 *
 * Works in both group chats and DMs.
 * Reads image files from /images/ and pulls descriptions from the roles array.
 *
 * Image filename convention (matches existing /images/ directory):
 *   "Godfather"          → godfather.png
 *   "PI"                 → pi.png
 *   "Private Investigator" → pi.png   (alias)
 *   All others           → rolename.toLowerCase() + ".png"
 */

"use strict";

const fs = require("fs");
const path = require("path");

const IMAGES_DIR = path.join(__dirname, "..", "images");

// ─────────────────────────────────────────────────────────────────────────────
// ROLES DATA (inline — no circular import needed)
// Pulled from the same source of truth used by setup.js and roleData.js.
// ─────────────────────────────────────────────────────────────────────────────

const ROLES = [
  // ── MAFIA ──────────────────────────────────────────────────────────────────
  {
    name: "Godfather",
    align: "Mafia",
    emoji: "🔴",
    description:
      "Commands the Mafia from the shadows — immune to investigation.",
    imageFile: "godfather.png",
  },
  {
    name: "Mafioso",
    align: "Mafia",
    emoji: "🔴",
    description: "Carries out the Godfather's kill order each night.",
    imageFile: "mafioso.png",
  },
  {
    name: "Framer",
    align: "Mafia",
    emoji: "🔴",
    description:
      "Plants false evidence — making innocents look guilty to investigators.",
    imageFile: "framer.png",
  },
  {
    name: "Silencer",
    align: "Mafia",
    emoji: "🔴",
    description:
      "Silences a player every other night, erasing their voice at Town Hall.",
    imageFile: "silencer.png",
  },

  // ── VILLAGE ─────────────────────────────────────────────────────────────────
  {
    name: "Doctor",
    align: "Village",
    emoji: "🟡",
    description:
      "Chooses one soul to protect each night — but never the same person twice.",
    imageFile: "doctor.png",
  },
  {
    name: "Detective",
    align: "Village",
    emoji: "🟡",
    description:
      "Investigates a player each night to determine if they serve the Mafia.",
    imageFile: "detective.png",
  },
  {
    name: "Vigilante",
    align: "Village",
    emoji: "🟡",
    description:
      "Takes justice into their own hands — but shooting an innocent is fatal guilt.",
    imageFile: "vigilante.png",
  },
  {
    name: "Mayor",
    align: "Village",
    emoji: "🟡",
    description:
      "Reveals their identity to cast two votes — power bought with a target on their back.",
    imageFile: "mayor.png",
  },
  {
    name: "Jailer",
    align: "Village",
    emoji: "🟡",
    description:
      "Locks a player away each night — protecting them, or executing them at will.",
    imageFile: "jailer.png",
  },
  {
    name: "Distractor",
    align: "Village",
    emoji: "🟡",
    description:
      "Lures a player away from their duty every other night, nullifying their action.",
    imageFile: "distractor.png",
  },
  {
    name: "PI",
    align: "Village",
    emoji: "🟡",
    description:
      "Compares two players each night to determine if they share the same allegiance.",
    imageFile: "pi.png",
  },
  {
    name: "Spy",
    align: "Village",
    emoji: "🟡",
    description:
      "Trails a target through the night — discovering who they visited.",
    imageFile: "spy.png",
  },

  // ── NEUTRAL ─────────────────────────────────────────────────────────────────
  {
    name: "Executioner",
    align: "Neutral",
    emoji: "🟣",
    description:
      "Must manipulate the town into lynching their one specific target — or become the Jester.",
    imageFile: "executioner.png",
  },
  {
    name: "Jester",
    align: "Neutral",
    emoji: "🟣",
    description:
      "Wins only by getting themselves executed — chaos is the only strategy.",
    imageFile: "jester.png",
  },
  {
    name: "Baiter",
    align: "Neutral",
    emoji: "🟣",
    description:
      "Lures three visitors into a deadly trap — survival is the prize.",
    imageFile: "baiter.png",
  },
  {
    name: "Arsonist",
    align: "Neutral",
    emoji: "🟣",
    description:
      "Douses players in silence, then ignites them all in a single catastrophic night.",
    imageFile: "arsonist.png",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// NAME → ROLE LOOKUP (case-insensitive + common aliases)
// ─────────────────────────────────────────────────────────────────────────────

const ALIASES = {
  "private investigator": "PI",
  "private-investigator": "PI",
  privateinvestigator: "PI",
  gf: "Godfather",
  doc: "Doctor",
  det: "Detective",
  vigil: "Vigilante",
  vig: "Vigilante",
  exec: "Executioner",
};

/**
 * Find a role object by name, case-insensitively, with alias support.
 * @param {string} query
 * @returns {Object|null}
 */
function findRole(query) {
  const q = query.trim().toLowerCase();

  // Alias match first
  const aliasTarget = ALIASES[q];
  if (aliasTarget) {
    return ROLES.find((r) => r.name === aliasTarget) ?? null;
  }

  // Exact case-insensitive match
  return ROLES.find((r) => r.name.toLowerCase() === q) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTION BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the HTML caption shown under each role card photo.
 * @param {Object} role
 * @returns {string}
 */

function esc(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildCaption(role) {
  return (
    `${role.emoji} <b>${esc(role.name)}</b>  ·  <i>${esc(role.align)}</i>\n\n` +
    `${esc(role.description)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE CARD SENDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send one role card (photo + caption) to a chat.
 * Falls back to a text message if the image file is missing.
 *
 * @param {Object} bot
 * @param {number|string} chatId
 * @param {Object}        role
 */
async function sendRoleCard(bot, chatId, role) {
  const imagePath = path.join(IMAGES_DIR, role.imageFile);
  const caption = buildCaption(role);

  if (fs.existsSync(imagePath)) {
    await bot.telegram.sendPhoto(
      chatId,
      { source: fs.createReadStream(imagePath) },
      { caption, parse_mode: "HTML" },
    );
  } else {
    // Graceful fallback — image not yet generated
    await bot.telegram.sendMessage(
      chatId,
      `🖼 <i>(Card image not found)</i>\n\n${caption}`,
      { parse_mode: "HTML" },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP SENDER  (used by /roles)
// Sends a labelled header then the cards for one alignment group.
// Uses individual sends with a short delay to avoid Telegram flood limits
// (30 messages/second per bot; we stay well under with a 350ms gap).
//
// Why not sendMediaGroup (album)?
//   Albums cap at 10 items, require all streams open simultaneously,
//   and strip individual captions in older clients.
//   Sequential sends with captions are more readable for a role browser.
// ─────────────────────────────────────────────────────────────────────────────

const SEND_DELAY_MS = 350; // stay safely under Telegram's rate limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a header message then all cards for one alignment.
 *
 * @param {Object}   bot
 * @param {number}   chatId
 * @param {string}   align     "Mafia" | "Village" | "Neutral"
 * @param {string}   emoji
 * @param {string}   headerBg  Decorative header string
 */
async function sendAlignmentGroup(bot, chatId, align, emoji, headerText) {
  const group = ROLES.filter((r) => r.align === align);

  // Section header
  await bot.telegram.sendMessage(
    chatId,
    `${emoji} <b>${headerText}</b>  (${group.length} roles)`,
    { parse_mode: "HTML" },
  );

  for (const role of group) {
    await sleep(SEND_DELAY_MS);
    await sendRoleCard(bot, chatId, role);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND MODULE
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  name: "roles",
  description: "Browse all role cards (/roles) or a single one (/role name).",

  /**
   * Handles both /roles and /role [name].
   * Registered in bot.js as two separate bot.command() calls pointing here.
   *
   * @param {Object}   ctx
   * @param {string[]} args       Parsed args from bot.js dispatcher.
   * @param {Object}   gameState  (unused here but kept for API consistency)
   * @param {Object}   bot
   * @param {string}   variant    "all" | "single"  — set by bot.js when registering
   */
  async execute(ctx, args, gameState, bot, variant = "all") {
    const chatId = ctx.chat.id;

    // ── /role [name] ───────────────────────────────────────────────────────
    if (variant === "single") {
      if (!args || args.length === 0) {
        return ctx.reply(
          `⚠️ Please provide a role name.\n\n` +
            `Example: <code>/role Doctor</code>\n\n` +
            `<b>Available roles:</b>\n` +
            ROLES.map((r) => `  ${r.emoji} ${r.name}`).join("\n"),
          { parse_mode: "HTML" },
        );
      }

      const query = args.join(" "); // support "private investigator" as args
      const role = findRole(query);

      if (!role) {
        // Suggest close matches (simple prefix search)
        const q = query.toLowerCase();
        const suggestions = ROLES.filter((r) =>
          r.name.toLowerCase().startsWith(q),
        )
          .map((r) => `  ${r.emoji} <code>/role ${r.name}</code>`)
          .join("\n");

        return ctx.reply(
          `⚠️ Role "<b>${query}</b>" not found.\n\n` +
            (suggestions
              ? `Did you mean:\n${suggestions}`
              : `Use /roles to see all available roles.`),
          { parse_mode: "HTML" },
        );
      }

      // Send a "typing" action so the user sees activity while the image loads
      await ctx.sendChatAction("upload_photo").catch(() => {});
      return sendRoleCard(bot, chatId, role);
    }

    // ── /roles (all cards) ─────────────────────────────────────────────────
    await ctx.reply(
      `🃏 <b>Mafiaville Role Cards</b>\n\n` +
        `Sending all <b>${ROLES.length} roles</b> grouped by alignment.\n` +
        `Use <code>/role [name]</code> to look up a single role anytime.`,
      { parse_mode: "HTML" },
    );

    await sleep(500);

    await sendAlignmentGroup(bot, chatId, "Mafia", "🔴", "Mafia Roles");
    await sleep(500);
    await sendAlignmentGroup(bot, chatId, "Village", "🟡", "Village Roles");
    await sleep(500);
    await sendAlignmentGroup(bot, chatId, "Neutral", "🟣", "Neutral Roles");

    await sleep(300);
    await bot.telegram.sendMessage(
      chatId,
      `✅ All ${ROLES.length} cards sent!\n\nUse <code>/role [name]</code> to revisit any card.`,
      { parse_mode: "HTML" },
    );
  },
};
