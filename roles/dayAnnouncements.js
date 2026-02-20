/**
 * roles/dayAnnouncements.js
 *
 * النسخة الجزائرية - Algerian Arabic Version
 * Night-result announcements and day-start attendance broadcast.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const IMAGES_DIR = path.join(__dirname, "..", "images");

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function toGroup(bot, groupChatId, text, imagePath = null) {
  try {
    if (imagePath && fs.existsSync(imagePath)) {
      const caption = text.length <= 1024 ? text : null;
      await bot.telegram.sendPhoto(
        groupChatId,
        { source: fs.createReadStream(imagePath) },
        caption ? { caption, parse_mode: "HTML" } : {},
      );
      if (!caption) {
        await bot.telegram.sendMessage(groupChatId, text, {
          parse_mode: "HTML",
        });
      }
    } else {
      await bot.telegram.sendMessage(groupChatId, text, { parse_mode: "HTML" });
    }
  } catch (err) {
    console.error("announcements toGroup error:", err.message);
  }
}

function mention(player) {
  return `<a href="tg://user?id=${player.id}">${player.username}</a>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// LAST WILL REVEAL
// ─────────────────────────────────────────────────────────────────────────────

async function revealLastWill(bot, groupChatId, player) {
  if (!player.lastWill || player.lastWill.length === 0) return;

  if (!player.silencedLastRound) {
    const lines = player.lastWill.map((l, i) => `${i + 1}. ${l}`).join("\n");
    await toGroup(
      bot,
      groupChatId,
      `📜 <b>الوصية تاع ${player.username}:</b>\n\n<pre>${escapeHtml(lines)}</pre>`,
    );
    await sleep(1500);
  } else {
    await bot.telegram
      .sendMessage(
        player.id,
        `🤫 <b>الوصية تاعك تخبات.</b>\n\n` +
          `قتلوك وانت "مسيلنسي" (سكّتوه) — الوصية تاعك ما تقدرش تظهر في هاد اللعبة.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN NIGHT RESULTS ANNOUNCER
// ─────────────────────────────────────────────────────────────────────────────

async function announceNightResults(bot, gameState) {
  const groupChatId = gameState.groupChatId;
  const dead = gameState.deadThisRound;

  if (dead.length === 0) {
    await toGroup(bot, groupChatId, `🌅 <b>فاتت ليلة هانية — ما صرا والو.</b>`);
    return;
  }

  await toGroup(
    bot,
    groupChatId,
    `🌅 <b>طلعت الشمس. صراو شي صوالح البارح في الليل…</b>`,
  );
  await sleep(1500);

  const doctorSavedIds = new Set(
    dead.filter((d) => d.by === "Doctor").map((d) => d.name),
  );

  for (const entry of dead) {
    const player = gameState.players.get(entry.name);

    switch (entry.by) {
      case "Mafia": {
        if (!player) break;
        const wasSaved = doctorSavedIds.has(entry.name);

        if (wasSaved) {
          await toGroup(
            bot,
            groupChatId,
            `🔴 <b>المافيا هجموا على ${player.username} البارح!</b>`,
            path.join(IMAGES_DIR, "death.png"),
          );
        } else {
          await toGroup(
            bot,
            groupChatId,
            `🔴 <b>المافيا هجموا على ${player.username} البارح!</b>\n\n` +
              `للأسف، الطبيب ما كانش تما باش يسلكو.`,
            path.join(IMAGES_DIR, "death.png"),
          );
          await sleep(1000);
          await revealLastWill(bot, groupChatId, player);
        }
        await sleep(2000);
        break;
      }

      case "Silencer": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `🔴 <b>المافيا هجموا على ${player.username} البارح!</b>\n\n` +
            `للأسف، الطبيب ما كانش تما باش يسلكو.`,
          path.join(IMAGES_DIR, "death.png"),
        );
        await sleep(2000);
        break;
      }

      case "Doctor": {
        await toGroup(
          bot,
          groupChatId,
          `🟢 <b>بصح الطبيب قدر يسلكو في آخر لحظة!</b>`,
          path.join(IMAGES_DIR, "health.png"),
        );
        await sleep(2000);
        break;
      }

      case "Vigilante": {
        if (!player) break;
        const align = player.align;
        const vigilante = gameState.players.get(entry.vigilId);

        let desc;
        if (align === "Village") {
          desc =
            `للأسف، ${mention(player)} كان <b>زوالي (من القرية)</b>.\n` +
            `${vigilante ? mention(vigilante) : "الفجيلانتي (Vigilante)"}، غاضو الحال بزاف ` +
            `وزاد ضرب روحو برصاصة من الندامة.`;
        } else if (align === "Mafia") {
          desc =
            `${mention(player)} طلع من <b>المافيا</b>! ` +
            `الفجيلانتي مازال عندو الرصاص لمرة خلاف.`;
        } else {
          desc = `${mention(player)} ما كان مع القرية ما كان مع المافيا.`;
        }

        await toGroup(
          bot,
          groupChatId,
          `🔫 <b>الفجيلانتي تيري على ${player.username} البارح!</b>\n\n${desc}`,
          path.join(IMAGES_DIR, "death.png"),
        );
        await sleep(1000);
        await revealLastWill(bot, groupChatId, player);

        if (align === "Village" && vigilante) {
          await sleep(1000);
          await revealLastWill(bot, groupChatId, vigilante);
        }
        await sleep(2000);
        break;
      }

      case "Mayor": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `🏛 <b>${player.username} كشف روحو بلي هو المير (الرئيس)!</b>\n\n` +
            `${mention(player)} درك عندو <b>دوبل فوط (2 أصوات)</b> في الاجتماع.`,
          path.join(IMAGES_DIR, "mayor.png"),
        );
        await sleep(2000);
        break;
      }

      case "Arsonist": {
        const burned = (entry.killed ?? [])
          .map((id) => gameState.players.get(id))
          .filter(Boolean);
        const burnList =
          burned.length > 0
            ? burned.map((p) => `• ${mention(p)}`).join("\n")
            : "حتى واحد";

        await toGroup(
          bot,
          groupChatId,
          `🔥 <b>كاين ناس يحبو يشوفو الدنيا تشعل.</b>\n\n` +
            `الارصونيست (Arsonist) حرق <b>${burned.length}</b> دار (ديار) البارح.\n\n` +
            `<b>الجثث لي لقيناهم:</b>\n${burnList}`,
          path.join(IMAGES_DIR, "death.png"),
        );

        for (const p of burned) {
          await sleep(1500);
          await revealLastWill(bot, groupChatId, p);
        }

        gameState.roleState.Arsonist.doused = [];
        await sleep(2000);
        break;
      }

      case "Baiter": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `💥 <b>${player.username} راح عند "البايتر" (Baiter) — وطرق عليه البيج!</b>\n\n` +
            `يا جماعة، عسّوا رواحكم وين تروحوا في الليل.`,
          path.join(IMAGES_DIR, "death.png"),
        );
        await sleep(1000);
        await revealLastWill(bot, groupChatId, player);
        await sleep(2000);
        break;
      }

      case "Jailer": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `⛓ <b>${player.username} جاز ليلة في الحبس ودارولو الإعدام!</b>\n\n` +
            `الغاشي راه حزين، وما علابالناش إذا كان مافيا ولا لا.`,
          path.join(IMAGES_DIR, "death.png"),
        );
        await sleep(1000);
        await revealLastWill(bot, groupChatId, player);
        await sleep(2000);
        break;
      }

      default:
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

async function announceDayAttendance(bot, gameState, round) {
  const groupChatId = gameState.groupChatId;

  const presentLines = [];
  const silencedIds = [];

  for (const id of gameState.playersAlive) {
    const p = gameState.players.get(id);
    if (!p) continue;
    if (p.silencedLastRound) {
      silencedIds.push(id);
    } else {
      presentLines.push(`• ${mention(p)}`);
    }
  }

  const deadIds = Array.from(gameState.players.keys()).filter(
    (id) => !gameState.playersAlive.includes(id),
  );

  const absentIds = [...deadIds];
  for (const sid of silencedIds) {
    const pos = Math.floor(Math.random() * (absentIds.length + 1));
    absentIds.splice(pos, 0, sid);
  }

  const absentLines = absentIds
    .map((id) => {
      const p = gameState.players.get(id);
      return p ? `• ${mention(p)}` : null;
    })
    .filter(Boolean);

  const presentText = presentLines.length > 0 ? presentLines.join("\n") : "—";
  const absentText = absentLines.length > 0 ? absentLines.join("\n") : "—";

  await toGroup(
    bot,
    groupChatId,
    `☀️ <b>اليوم ${round} — الاجتماع راهو مفتوح</b>\n\n` +
      `<b>✅ لي حاضرين:</b>\n${presentText}\n\n` +
      `<b>❌ لي غايبين:</b>\n${absentText}`,
  );
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  announceNightResults,
  announceDayAttendance,
  revealLastWill,
};
