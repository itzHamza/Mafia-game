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
  // ── العصابة (MAFIA) ────────────────────────────────────────────────────────
  {
    name: "البوص (Godfather)",
    align: "العصابة",
    emoji: "🔴",
    description:
      "يسير في 'الخدمة' من البعيد وما يبانش — لانسبيكتور ما يقدرش يفيق بيه كاع.",
    imageFile: "godfather.png",
  },
  {
    name: "الذراع الأيمن (Mafioso)",
    align: "العصابة",
    emoji: "🔴",
    description: "هو اللي ينفذ الأوامر تاع البوص ويصفيها لواحد كل ليلة.",
    imageFile: "mafioso.png",
  },
  {
    name: "المزوّر (Framer)",
    align: "العصابة",
    emoji: "🔴",
    description:
      "يلصق التهم باطل — يخلي ولاد الحومة Innocent يبانوا غلّاطين عند لانسبيكتور.",
    imageFile: "framer.png",
  },
  {
    name: "الساكت (Silencer)",
    align: "العصابة",
    emoji: "🔴",
    description:
      "يبلع الفم لواحد ليلة بليلة، باش غدوة من ذاك ما يقدرش يحل فمه في 'الميري'.",
    imageFile: "silencer.png",
  },

  // ── ولاد الحومة (VILLAGE) ───────────────────────────────────────────────────
  {
    name: "الطبيب (Doctor)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يخير واحد كل ليلة باش يسلكو من الموت — بصح ما يسلكش نفس الشخص مرتين.",
    imageFile: "doctor.png",
  },
  {
    name: "لانسبيكتور (Detective)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يفتش على واحد كل ليلة باش يعرف إذا راهو يخدم مع العصابة ولا خاطيه.",
    imageFile: "detective.png",
  },
  {
    name: "المقرود (Vigilante)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يجيب حقو بيدو وييري في المشبوهين — بصح إذا غلط في واحد بريء يموت بالسم.",
    imageFile: "vigilante.png",
  },
  {
    name: "المير (Mayor)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يبين هويتو للناس باش يولي صوتو يسوى زوج — بصح هكا يولي هو 'السيبل' تاع العصابة.",
    imageFile: "mayor.png",
  },
  {
    name: "الحبّاس (Jailer)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يبلع على واحد كل ليلة — باش يحميه من الموت، ولا 'يعدمو' إذا شك فيه.",
    imageFile: "jailer.png",
  },
  {
    name: "المبرزي (Distractor)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يتلف الخيط لواحد ليلة بليلة، يخليه ينسى واش كان رايح يدير ويعطل خدمتو.",
    imageFile: "distractor.png",
  },
  {
    name: "الفحصيص (PI)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يقارن بين زوج عباد في الليل باش يعرف إذا راهم في نفس الجهة ولا لالا.",
    imageFile: "pi.png",
  },
  {
    name: "الڤمّاص (Spy)",
    align: "الحومة",
    emoji: "🟡",
    description:
      "يتبع واحد في السكات طول الليل — باش يعرف شكون اللي راح زارهم.",
    imageFile: "spy.png",
  },

  // ── طرف ثالث (NEUTRAL) ────────────────────────────────────────────────────
  {
    name: "مول الكونترا (Executioner)",
    align: "محايد",
    emoji: "🟣",
    description:
      "لازم يغلط الحومة باش يقتلوا واحد محدد راهو حاطو في راسو — وإلا يولي بهلول.",
    imageFile: "executioner.png",
  },
  {
    name: "البهلول (Jester)",
    align: "محايد",
    emoji: "🟣",
    description:
      "يربح غير إذا خلى الحومة تفوطي عليه ويعدموه — التمنيك هو السلاح تاعو.",
    imageFile: "jester.png",
  },
  {
    name: "الشيخ المقاردي (Baiter)",
    align: "محايد",
    emoji: "🟣",
    description:
      "يجر 3 عباد للفخ تاعو ويطرطقهم بالبارود — المهم يسلك هو في الأخير.",
    imageFile: "baiter.png",
  },
  {
    name: "الشاعلي (Arsonist)",
    align: "محايد",
    emoji: "🟣",
    description:
      "يرش الناس بالليسانس في السكات، ومن بعد يشعل فيهم النار قاع ضربة وحدة.",
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

    await sendAlignmentGroup(bot, chatId, "العصابة", "🔴", "أدوار العصابة");
    await sleep(500);
    await sendAlignmentGroup(
      bot,
      chatId,
      "الحومة",
      "🟡",
      "أدوار ولاد الحومة",
    );
    await sleep(500);
    await sendAlignmentGroup(bot, chatId, "محايد", "🟣", "أدوار محايدة");

    await sleep(300);
    await bot.telegram.sendMessage(
      chatId,
      `✅ All ${ROLES.length} cards sent!\n\nUse <code>/role [name]</code> to revisit any card.`,
      { parse_mode: "HTML" },
    );
  },
};
