/**
 * commands/setup.js — DEBUG BUILD
 *
 * Key log tags:
 *   [SETUP] JOIN — player count, role distribution
 *   [SETUP-DM] SEND/SENT/FAIL — individual role card DM timing per userId
 *
 * If a setup DM hangs, SEND will appear without a matching SENT/FAIL.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const {
  ROLES,
  MAFIA_TIERS,
  VILLAGE_TIERS,
  NEUTRAL_TIERS,
  ALIGN_EMOJI,
} = require("../roles/roleData");

const IMAGES_DIR = path.join(__dirname, "..", "images");

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}
function log(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}
function warn(tag, msg) {
  console.warn(`[${ts()}] [${tag}] ⚠️  ${msg}`);
}
function err(tag, msg) {
  console.error(`[${ts()}] [${tag}] ❌ ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE PICKER (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function pickRole(tiersClone, state) {
  const tier = tiersClone[state.currentTier];
  let roleName;

  if (!tier) {
    roleName =
      state.rolePool[Math.floor(Math.random() * state.rolePool.length)];
  } else if (!tier.pick) {
    roleName = tier.roles[Math.floor(Math.random() * tier.roles.length)];
    tier.roles = tier.roles.filter((r) => r !== roleName);
    if (tier.roles.length === 0) state.currentTier++;
  } else {
    roleName = tier.roles[Math.floor(Math.random() * tier.roles.length)];
    tier.roles = tier.roles.filter((r) => r !== roleName);
    tier.pick--;
    if (!tier.pick) state.currentTier++;
  }

  state.rolePool = state.rolePool.filter((r) => r !== roleName);
  return roleName;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE CARD FORMATTER (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function formatRoleCard(roleName, roleInfo) {
  const emoji = ALIGN_EMOJI[roleInfo.align] ?? "⚪";
  return (
    `🎭 <b>You are the ${roleName.toUpperCase()}</b>\n\n` +
    `${emoji} <b>Alignment:</b> ${roleInfo.align}\n\n` +
    `📖 <i>${roleInfo.description}</i>\n\n` +
    `🎯 <b>Goal:</b> ${roleInfo.goal}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DM SENDERS — all individually timed
// ─────────────────────────────────────────────────────────────────────────────

async function sendRoleCard(bot, userId, roleName, roleInfo) {
  const cardText = formatRoleCard(roleName, roleInfo);
  const imagePath = path.join(IMAGES_DIR, roleInfo.image);
  const imageExists = fs.existsSync(imagePath);

  log(
    "SETUP-DM",
    `SEND userId=${userId} role=${roleName} hasImage=${imageExists}`,
  );
  const t = Date.now();

  try {
    if (imageExists) {
      if (cardText.length <= 1024) {
        await bot.telegram.sendPhoto(
          userId,
          { source: fs.createReadStream(imagePath) },
          { caption: cardText, parse_mode: "HTML" },
        );
      } else {
        await bot.telegram.sendPhoto(userId, {
          source: fs.createReadStream(imagePath),
        });
        await bot.telegram.sendMessage(userId, cardText, {
          parse_mode: "HTML",
        });
      }
    } else {
      warn(
        "SETUP-DM",
        `Image missing for role=${roleName} — sending text only`,
      );
      await bot.telegram.sendMessage(userId, cardText, { parse_mode: "HTML" });
    }

    log(
      "SETUP-DM",
      `SENT userId=${userId} role=${roleName} in ${Date.now() - t}ms`,
    );
    return { success: true };
  } catch (e) {
    err(
      "SETUP-DM",
      `FAIL userId=${userId} role=${roleName} after ${Date.now() - t}ms — ${e.message}`,
    );
    return { success: false, error: e.message };
  }
}

async function sendMafiaTeamDM(bot, userId, mafiaIds, players) {
  const teammates = mafiaIds
    .filter((id) => id !== userId)
    .map((id) => {
      const p = players.get(id);
      return `• <b>${p.username}</b> — ${p.role}`;
    });

  const msg =
    teammates.length > 0
      ? `🔴 <b>Your Mafia teammates:</b>\n${teammates.join("\n")}\n\nCoordinate via DM.`
      : `🔴 <b>You are the sole Mafia member</b> this game. Good luck!`;

  log("SETUP-DM", `SEND Mafia roster to userId=${userId}`);
  const t = Date.now();
  await bot.telegram
    .sendMessage(userId, msg, { parse_mode: "HTML" })
    .catch((e) => {
      err(
        "SETUP-DM",
        `Mafia roster FAIL userId=${userId} after ${Date.now() - t}ms — ${e.message}`,
      );
    });
  log("SETUP-DM", `Mafia roster SENT userId=${userId} in ${Date.now() - t}ms`);
}

async function sendExecutionerTargetDM(bot, userId, targetId, players) {
  const target = players.get(targetId);
  if (!target) return;
  const imagePath = path.join(IMAGES_DIR, "death.png");
  const msg =
    `🎯 <b>Your target is ${target.username}.</b>\n\nYour goal is to get them <b>lynched</b> by the town.\n\n` +
    `If they die during the <i>night</i> instead, you will automatically become the <b>Jester</b>.`;

  log(
    "SETUP-DM",
    `SEND Executioner target to userId=${userId} targetId=${targetId}`,
  );
  const t = Date.now();
  try {
    if (fs.existsSync(imagePath)) {
      await bot.telegram.sendPhoto(
        userId,
        { source: fs.createReadStream(imagePath) },
        { caption: msg, parse_mode: "HTML" },
      );
    } else {
      await bot.telegram.sendMessage(userId, msg, { parse_mode: "HTML" });
    }
    log(
      "SETUP-DM",
      `Executioner target SENT userId=${userId} in ${Date.now() - t}ms`,
    );
  } catch (e) {
    err(
      "SETUP-DM",
      `Executioner target FAIL userId=${userId} after ${Date.now() - t}ms — ${e.message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLLBACK (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function rollbackSetup(gameState) {
  log("SETUP", "Rolling back setup...");
  for (const [, player] of gameState.players) {
    player.role = undefined;
    player.align = undefined;
  }
  gameState.phase = "lobby";
  gameState.gameReady = false;
  gameState.playersAlive = [];
  gameState.mafiaPlayers = [];
  gameState.villagePlayers = [];
  gameState.neutralPlayers = [];
  gameState.currentMafia = {
    Godfather: null,
    Mafioso: null,
    Framer: null,
    Silencer: null,
  };

  const rs = gameState.roleState;
  rs.Silencer.workedLastNight = false;
  rs.Silencer.silencedSoFar = [];
  rs.Silencer.silencerId = null;
  rs.Doctor.lastChoice = null;
  rs.Doctor.doctorId = null;
  rs.Jailer.canJail = true;
  rs.Jailer.killsLeft = 3;
  rs.Jailer.lastSelection = null;
  rs.Jailer.previousSelection = null;
  rs.Jailer.jailerId = null;
  rs.Distractor.workedLastNight = false;
  rs.Distractor.distractorId = null;
  rs.Mayor.revealed = false;
  rs.Mayor.mayorId = null;
  rs.Executioner.target = null;
  rs.Executioner.isJester = false;
  rs.Executioner.executionerId = null;
  rs.Baiter.baitedCount = 0;
  rs.Baiter.baiterId = null;
  rs.Arsonist.doused = [];
  rs.Arsonist.alreadyDead = false;
  rs.Arsonist.arsonistId = null;
  log("SETUP", "Rollback complete");
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  name: "setup",
  description:
    "Set up a new game by assigning roles to all players in the lobby.",

  async execute(ctx, args, gameState, bot) {
    log(
      "SETUP",
      `Invoked by from=${ctx.from.id} players=${gameState.players.size}`,
    );

    if (ctx.chat.type === "private") {
      return ctx.reply("⚠️ This command must be used in the group chat.");
    }
    if (gameState.players.size < 1) {
      return ctx.reply(
        `⚠️ Not enough players! You need at least <b>5</b> to play.\nCurrent: <b>${gameState.players.size}</b>`,
        { parse_mode: "HTML" },
      );
    }
    if (gameState.phase === "setup")
      return ctx.reply("⏳ Setup is already in progress.");
    if (gameState.gameReady || gameState.isGameActive) {
      return ctx.reply(
        "⚠️ The game is already set up. Use /startgame to begin.",
      );
    }

    const issuerId = ctx.from.id;
    const issuer = gameState.players.get(issuerId);
    if (!(issuer?.isHost || ADMIN_IDS.includes(issuerId))) {
      return ctx.reply("⚠️ Only the 👑 <b>Host</b> can run /setup.", {
        parse_mode: "HTML",
      });
    }

    gameState.phase = "setup";
    log("SETUP", "Phase set to setup");

    await ctx.reply(
      `⚙️ <b>Setting up Mafiaville for ${gameState.players.size} players…</b>\n\n` +
        `Each player will receive their role via 📨 <b>private message</b>.\n\n` +
        `⚠️ If you haven't messaged me privately, tap my profile and press <b>Start</b>.`,
      { parse_mode: "HTML" },
    );

    // Group size calculation
    const playerCount = gameState.players.size;
    const mafiaHidden = gameState.settings.mafiaHidden;
    let mafiaCount, neutralCount;

    if ((mafiaHidden && playerCount >= 10) || playerCount >= 13) {
      mafiaCount = 3;
      neutralCount = Math.round(Math.random()) + 2;
      if (playerCount > 11) neutralCount++;
    } else if ((mafiaHidden && playerCount >= 6) || playerCount >= 8) {
      mafiaCount = 2;
      neutralCount = Math.round(Math.random());
      if (playerCount > 7) neutralCount++;
    } else {
      mafiaCount = 1;
      neutralCount = 1;
    }

    const villagerCount = playerCount - mafiaCount - neutralCount;
    log(
      "SETUP",
      `Distribution: mafia=${mafiaCount} village=${villagerCount} neutral=${neutralCount}`,
    );

    gameState.playersAlive = Array.from(gameState.players.keys());
    const playerPool = Array.from(gameState.players.keys());

    function drawPlayer() {
      const idx = Math.floor(Math.random() * playerPool.length);
      const [id] = playerPool.splice(idx, 1);
      return id;
    }

    // Assign Mafia
    const mafiaState = { currentTier: 1, rolePool: [...MAFIA_TIERS.pool] };
    const mafiaClone = JSON.parse(JSON.stringify(MAFIA_TIERS));
    for (let i = 0; i < mafiaCount; i++) {
      const userId = drawPlayer();
      const roleName = pickRole(mafiaClone, mafiaState);
      const player = gameState.players.get(userId);
      player.role = roleName;
      player.align = "Mafia";
      if (
        Object.prototype.hasOwnProperty.call(gameState.currentMafia, roleName)
      ) {
        gameState.currentMafia[roleName] = userId;
      }
      gameState.mafiaPlayers.push(userId);
      log(
        "SETUP",
        `Assigned Mafia: userId=${userId} username=${player.username} role=${roleName}`,
      );
    }

    // Assign Village
    const villageState = { currentTier: 1, rolePool: [...VILLAGE_TIERS.pool] };
    const villageClone = JSON.parse(JSON.stringify(VILLAGE_TIERS));
    for (let i = 0; i < villagerCount; i++) {
      const userId = drawPlayer();
      const roleName = pickRole(villageClone, villageState);
      const player = gameState.players.get(userId);
      player.role = roleName;
      player.align = "Village";
      gameState.villagePlayers.push(userId);
      log(
        "SETUP",
        `Assigned Village: userId=${userId} username=${player.username} role=${roleName}`,
      );
    }

    // Assign Neutral
    const neutralState = { currentTier: 1, rolePool: [...NEUTRAL_TIERS.pool] };
    const neutralClone = JSON.parse(JSON.stringify(NEUTRAL_TIERS));
    for (let i = 0; i < neutralCount; i++) {
      const userId = drawPlayer();
      const roleName = pickRole(neutralClone, neutralState);
      const player = gameState.players.get(userId);
      player.role = roleName;
      player.align = "Neutral";
      gameState.neutralPlayers.push(userId);
      log(
        "SETUP",
        `Assigned Neutral: userId=${userId} username=${player.username} role=${roleName}`,
      );

      if (roleName === "Executioner") {
        const eligibleTargets = gameState.villagePlayers.filter(
          (id) => gameState.players.get(id)?.role !== "Mayor",
        );
        if (eligibleTargets.length > 0) {
          const targetId =
            eligibleTargets[Math.floor(Math.random() * eligibleTargets.length)];
          gameState.roleState.Executioner.target = targetId;
          gameState.roleState.Executioner.executionerId = userId;
          log(
            "SETUP",
            `Executioner target: userId=${userId} → targetId=${targetId}`,
          );
        }
      }
    }

    // Populate role state IDs
    const rs = gameState.roleState;
    for (const [userId, player] of gameState.players) {
      switch (player.role) {
        case "Godfather":
          rs.Godfather.godfatherId = userId;
          break;
        case "Mafioso":
          rs.Mafioso.mafiosoId = userId;
          break;
        case "Framer":
          rs.Framer.framerId = userId;
          break;
        case "Silencer":
          rs.Silencer.silencerId = userId;
          break;
        case "Doctor":
          rs.Doctor.doctorId = userId;
          break;
        case "Detective":
          rs.Detective.detectiveId = userId;
          break;
        case "Vigilante":
          rs.Vigilante.vigilanteId = userId;
          break;
        case "Mayor":
          rs.Mayor.mayorId = userId;
          break;
        case "Jailer":
          rs.Jailer.jailerId = userId;
          break;
        case "Distractor":
          rs.Distractor.distractorId = userId;
          break;
        case "PI":
          rs.PI.piId = userId;
          break;
        case "Spy":
          rs.Spy.spyId = userId;
          break;
        case "Jester":
          rs.Jester.jesterId = userId;
          break;
        case "Baiter":
          rs.Baiter.baiterId = userId;
          break;
        case "Arsonist":
          rs.Arsonist.arsonistId = userId;
          break;
      }
    }
    log("SETUP", "Role state IDs populated");

    // Send role DMs — sequentially with individual timing
    log(
      "SETUP",
      `Sending role DMs to ${gameState.players.size} players (sequential with 200ms gap)...`,
    );

    const dmResults = await Promise.all(
      Array.from(gameState.players.entries()).map(async ([userId, player]) => {
        const roleInfo = ROLES[player.role];
        if (!roleInfo) {
          err(
            "SETUP-DM",
            `No role data for role=${player.role} userId=${userId}`,
          );
          return {
            userId,
            username: player.username,
            success: false,
            error: `Unknown role: ${player.role}`,
          };
        }

        const result = await sendRoleCard(bot, userId, player.role, roleInfo);
        if (!result.success) {
          return { userId, username: player.username, ...result };
        }

        if (player.align === "Mafia") {
          await sendMafiaTeamDM(
            bot,
            userId,
            gameState.mafiaPlayers,
            gameState.players,
          );
        }
        if (player.role === "Executioner" && rs.Executioner.target) {
          await sendExecutionerTargetDM(
            bot,
            userId,
            rs.Executioner.target,
            gameState.players,
          );
        }

        return { userId, username: player.username, success: true };
      }),
    );

    const failures = dmResults.filter((r) => !r.success);
    log(
      "SETUP",
      `DM results: success=${dmResults.length - failures.length} failures=${failures.length}`,
    );

    if (failures.length > 0) {
      const failList = failures
        .map((r) => `• ${r.username} — ${r.error}`)
        .join("\n");
      err("SETUP", `DM failures:\n${failList}`);
      rollbackSetup(gameState);
      await ctx.reply(
        `❌ <b>Setup failed!</b>\n\nPlayers who couldn't receive their role:\n${failures.map((r) => `• ${r.username}`).join("\n")}\n\n` +
          `Have each listed player open a private chat with me (/start), then the host can run /setup again.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    gameState.gameReady = true;
    gameState.phase = "lobby";
    log("SETUP", "Setup complete — gameReady=true phase=lobby");

    const alignBreakdown =
      `🔴 Mafia: <b>${mafiaCount}</b>\n` +
      `🟢 Village: <b>${villagerCount}</b>\n` +
      `🔵 Neutral: <b>${neutralCount}</b>`;

    await ctx.reply(
      `✅ <b>Mafiaville is ready!</b>\n\n👥 <b>${playerCount} players</b> assigned roles:\n${alignBreakdown}\n\n` +
        `📨 Everyone has received their role.\n\nWhen ready, use /startgame.`,
      { parse_mode: "HTML" },
    );
  },
};
