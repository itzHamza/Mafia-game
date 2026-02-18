/**
 * roles/dayAnnouncements.js
 *
 * Night-result announcements and day-start attendance broadcast.
 *
 * Discord equivalent: the big for/switch loop over gamedata.game.game.deadThisRound
 * inside dayTime() in commands/start.js, plus the alive/absent embed.
 *
 * Replacements:
 *   channel.send(new Discord.MessageEmbed())  → bot.telegram.sendMessage(groupChatId, html)
 *   embed.attachFiles([image]).setThumbnail() → bot.telegram.sendPhoto(groupChatId, ...)
 *   <@userId> mention                         → <a href="tg://user?id=X">Name</a>
 *   player.will                               → player.lastWill (renamed in Phase 2)
 *   player.silencedLastRound will-suppression → same flag, same logic
 */

"use strict";

const fs = require("fs");
const path = require("path");

const IMAGES_DIR = path.join(__dirname, "..", "images");

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an HTML message to the group, optionally with a thumbnail image.
 * Discord equivalent: channel.send({ embed, files: [imagePath] })
 */
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

/**
 * Format a player as a tappable Telegram inline mention.
 * Discord equivalent: `<@${player.id}>`
 */
function mention(player) {
  return `<a href="tg://user?id=${player.id}">${player.username}</a>`;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// LAST WILL REVEAL
// Discord equivalent:
//   if (!player.silencedLastRound && player.will.length !== 0) {
//     will = new Discord.MessageEmbed()...
//     await channel.send(will);
//   } else if (player.will.length !== 0) {
//     user.send(suppressedWill);
//   }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reveal a player's last will in the group chat, or DM them the suppression notice.
 *
 * @param {Object} bot
 * @param {number} groupChatId
 * @param {Object} player       Player object from gameState.players
 */
async function revealLastWill(bot, groupChatId, player) {
  if (!player.lastWill || player.lastWill.length === 0) return;

  if (!player.silencedLastRound) {
    // Public reveal
    // Discord equivalent: channel.send(new Discord.MessageEmbed().setTitle("last will"))
    const lines = player.lastWill.map((l, i) => `${i + 1}. ${l}`).join("\n");
    await toGroup(
      bot,
      groupChatId,
      `📜 <b>${player.username}'s last will:</b>\n\n<pre>${escapeHtml(lines)}</pre>`,
    );
    await sleep(1500);
  } else {
    // Will suppressed — notify the player privately
    // Discord equivalent: user.send(suppressedWill embed)
    await bot.telegram
      .sendMessage(
        player.id,
        `🤫 <b>Your last will was suppressed.</b>\n\n` +
          `You were killed while silenced — your will cannot be revealed this game.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN NIGHT RESULTS ANNOUNCER
// Discord equivalent: the for/switch block inside dayTime() in start.js
//
// deadThisRound entry shapes:
//   { name: userId, by: "Mafia" }
//   { name: userId, by: "Silencer" }           ← player silenced (appears as attack)
//   { name: userId, by: "Doctor" }             ← player SAVED (not killed)
//   { name: userId, by: "Vigilante", vigilId } ← target shot; vigilId = shooter
//   { name: userId, by: "Vigilante-guilt" }    ← vigilante died of guilt (skip in loop)
//   { name: userId, by: "Mayor" }              ← reveal event (not a death)
//   { name: userId, by: "Arsonist", killed: userId[] }
//   { name: userId, by: "Baiter" }
//   { name: userId, by: "Jailer" }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Announce the results of the previous night to the group.
 * Called at the start of each day phase, before voting.
 *
 * @param {Object} bot
 * @param {Object} gameState
 */
async function announceNightResults(bot, gameState) {
  const groupChatId = gameState.groupChatId;
  const dead = gameState.deadThisRound;

  if (dead.length === 0) {
    await toGroup(
      bot,
      groupChatId,
      `🌅 <b>The night passed quietly — nothing eventful happened.</b>`,
    );
    return;
  }

  await toGroup(
    bot,
    groupChatId,
    `🌅 <b>The sun rises. A few things happened last night…</b>`,
  );
  await sleep(1500);

  // Pre-scan: which players were saved by the Doctor?
  // Discord equivalent: the inline if (deadThisRound.filter(d => d.by === "Doctor").length === 0) check
  const doctorSavedIds = new Set(
    dead.filter((d) => d.by === "Doctor").map((d) => d.name),
  );

  for (const entry of dead) {
    const player = gameState.players.get(entry.name);

    switch (entry.by) {
      // ── Mafia kill ────────────────────────────────────────────────────
      // Discord equivalent: case "Mafia" in dayTime() switch
      case "Mafia": {
        if (!player) break;
        const wasSaved = doctorSavedIds.has(entry.name);

        if (wasSaved) {
          // Doctor save — announce attack only (Doctor case follows separately)
          await toGroup(
            bot,
            groupChatId,
            `🔴 <b>The Mafia attacked ${player.username} last night!</b>`,
            path.join(IMAGES_DIR, "death.png"),
          );
        } else {
          // No save — announce death + will
          await toGroup(
            bot,
            groupChatId,
            `🔴 <b>The Mafia attacked ${player.username} last night!</b>\n\n` +
              `Unfortunately, the Doctor was nowhere to be found.`,
            path.join(IMAGES_DIR, "death.png"),
          );
          await sleep(1000);
          await revealLastWill(bot, groupChatId, player);
        }
        await sleep(2000);
        break;
      }

      // ── Silencer (attack bluff) ───────────────────────────────────────
      // Discord equivalent: case "Silencer" in dayTime() switch
      // The town sees this as a "Mafia attack" — the silenced player appears absent.
      // This is an INTENTIONAL deception mechanic from the original.
      case "Silencer": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `🔴 <b>The Mafia attacked ${player.username} last night!</b>\n\n` +
            `Unfortunately, the Doctor was nowhere to be found.`,
          path.join(IMAGES_DIR, "death.png"),
        );
        await sleep(2000);
        break;
      }

      // ── Doctor save ───────────────────────────────────────────────────
      // Discord equivalent: case "Doctor" in dayTime() switch
      case "Doctor": {
        await toGroup(
          bot,
          groupChatId,
          `🟢 <b>However, the Doctor was able to save them!</b>`,
          path.join(IMAGES_DIR, "health.png"),
        );
        await sleep(2000);
        break;
      }

      // ── Vigilante shot ────────────────────────────────────────────────
      // Discord equivalent: case "Vigilante" in dayTime() switch
      case "Vigilante": {
        if (!player) break;
        const align = player.align;
        const vigilante = gameState.players.get(entry.vigilId);

        let desc;
        if (align === "Village") {
          // Vigilante killed an innocent → dies of guilt
          // Discord: "unfortunately, <@vigilante> was a villager. The vigilante committed suicide."
          desc =
            `Unfortunately, ${mention(player)} was a <b>Villager</b>.\n` +
            `${vigilante ? mention(vigilante) : "The Vigilante"}, overcome with guilt, ` +
            `loaded their gun for one final shot: themselves.`;
        } else if (align === "Mafia") {
          desc =
            `${mention(player)} was <b>Mafia</b>! ` +
            `The Vigilante lives to shoot another day.`;
        } else {
          desc =
            `${mention(player)} did not align with the Village, ` +
            `but also didn't agree with the Mafia's methods.`;
        }

        await toGroup(
          bot,
          groupChatId,
          `🔫 <b>The Vigilante shot ${player.username} last night!</b>\n\n${desc}`,
          path.join(IMAGES_DIR, "death.png"),
        );
        await sleep(1000);
        await revealLastWill(bot, groupChatId, player);

        // Vigilante's own will if they died of guilt
        if (align === "Village" && vigilante) {
          await sleep(1000);
          await revealLastWill(bot, groupChatId, vigilante);
        }
        await sleep(2000);
        break;
      }

      // ── Vigilante guilt (skip — announced above) ──────────────────────
      case "Vigilante-guilt":
        break;

      // ── Mayor reveal ──────────────────────────────────────────────────
      // Discord equivalent: case "Mayor" in dayTime() switch
      case "Mayor": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `🏛 <b>${player.username} has revealed themselves as the Mayor!</b>\n\n` +
            `${mention(player)} will now cast <b>two votes</b> at Town Hall meetings.`,
          path.join(IMAGES_DIR, "mayor.png"),
        );
        await sleep(2000);
        break;
      }

      // ── Arsonist ignite ───────────────────────────────────────────────
      // Discord equivalent: case "Arsonist" in dayTime() switch
      case "Arsonist": {
        const burned = (entry.killed ?? [])
          .map((id) => gameState.players.get(id))
          .filter(Boolean);
        const burnList =
          burned.length > 0
            ? burned.map((p) => `• ${mention(p)}`).join("\n")
            : "None";

        await toGroup(
          bot,
          groupChatId,
          `🔥 <b>Some people just want to watch the world burn.</b>\n\n` +
            `The Arsonist burned <b>${burned.length}</b> home(s) last night.\n\n` +
            `<b>Identified bodies:</b>\n${burnList}`,
          path.join(IMAGES_DIR, "death.png"),
        );

        for (const p of burned) {
          await sleep(1500);
          await revealLastWill(bot, groupChatId, p);
        }

        // Reset the doused list after an ignite
        // Discord equivalent: gamedata.neutralRoles["Arsonist"].doused = []
        // in the case "Arsonist" announcement block
        gameState.roleState.Arsonist.doused = [];
        await sleep(2000);
        break;
      }

      // ── Baiter trap ───────────────────────────────────────────────────
      // Discord equivalent: case "Baiter" in dayTime() switch
      case "Baiter": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `💥 <b>${player.username} visited the Baiter last night — and was blown up!</b>\n\n` +
            `A statement has been issued urging caution about whom you visit at night.`,
          path.join(IMAGES_DIR, "death.png"),
        );
        await sleep(1000);
        await revealLastWill(bot, groupChatId, player);
        await sleep(2000);
        break;
      }

      // ── Jailer execution ──────────────────────────────────────────────
      // Discord equivalent: case "Jailer" in dayTime() switch
      case "Jailer": {
        if (!player) break;
        await toGroup(
          bot,
          groupChatId,
          `⛓ <b>${player.username} was jailed and executed last night!</b>\n\n` +
            `The town mourns, not knowing if the victim was Mafia.`,
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
// Discord equivalent: the dayStartMsg embed with "Present" and "Absent" fields
// in dayTime() after the night-result announcements.
//
// Silenced players appear in the Absent column (deceptive — town can't tell
// if someone is silenced or dead from attendance alone).
// Discord equivalent: if (silenced) playersDead.splice(random, 0, silenced)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post the day-start attendance message to the group.
 *
 * @param {Object} bot
 * @param {Object} gameState
 * @param {number} round
 */
async function announceDayAttendance(bot, gameState, round) {
  const groupChatId = gameState.groupChatId;

  // Present: alive and NOT silenced
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

  // Absent: dead players + silenced players mixed together randomly
  // Discord equivalent: playersDead + silenced spliced in at random position
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
    `☀️ <b>Day ${round} — Town Hall is in session</b>\n\n` +
      `<b>✅ Present:</b>\n${presentText}\n\n` +
      `<b>❌ Absent:</b>\n${absentText}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

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
