/**
 * commands/setup.js
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

const { log, warn, err } = require("../logger");

// ─────────────────────────────────────────────────────────────────────────────
// ROLE PICKER
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
// ROLE CARD FORMATTER
// ─────────────────────────────────────────────────────────────────────────────

function formatRoleCard(roleName, roleInfo) {
  const emoji = ALIGN_EMOJI[roleInfo.align] ?? "⚪";
  return (
    `🎭 <b>نتا هو ${roleName.toUpperCase()}</b>\n\n` +
    `${emoji} <b>الجهة :</b> ${roleInfo.align}\n\n` +
    `📖 <i>${roleInfo.description}</i>\n\n` +
    `🎯 <b>الهدف تاعك :</b> ${roleInfo.goal}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DM SENDERS
// ─────────────────────────────────────────────────────────────────────────────

async function sendRoleCard(bot, userId, roleName, roleInfo, playerName) {
  const cardText = formatRoleCard(roleName, roleInfo);
  const imagePath = path.join(IMAGES_DIR, roleInfo.image);
  const imageExists = fs.existsSync(imagePath);

  log("SETUP", `Sending role card to ${playerName} (${roleName})...`);

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
      await bot.telegram.sendMessage(userId, cardText, { parse_mode: "HTML" });
    }

    log("SETUP", `✅ ${playerName} received their role card`);
    return { success: true };
  } catch (e) {
    err(
      "SETUP",
      `❌ Could not reach ${playerName} — they need to /start the bot first (${e.message})`,
    );
    return { success: false, error: e.message };
  }
}

async function sendMafiaTeamDM(bot, userId, mafiaIds, players, playerName) {
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

  await bot.telegram
    .sendMessage(userId, msg, { parse_mode: "HTML" })
    .catch((e) =>
      err(
        "SETUP",
        `Could not send Mafia team info to ${playerName}: ${e.message}`,
      ),
    );
}

async function sendExecutionerTargetDM(
  bot,
  userId,
  targetId,
  players,
  playerName,
) {
  const target = players.get(targetId);
  if (!target) return;
  const imagePath = path.join(IMAGES_DIR, "death.png");
  const msg =
    `🎯 <b>Your target is ${target.username}.</b>\n\nYour goal is to get them <b>lynched</b> by the town.\n\n` +
    `If they die during the <i>night</i> instead, you will automatically become the <b>Jester</b>.`;

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
  } catch (e) {
    err(
      "SETUP",
      `Could not send Executioner target info to ${playerName}: ${e.message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLLBACK
// ─────────────────────────────────────────────────────────────────────────────

function rollbackSetup(gameState) {
  log("SETUP", "Rolling back setup — restoring lobby state...");
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
  log("SETUP", "Rollback complete — players can run /setup again");
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  name: "setup",
  description:
    "Set up a new game by assigning roles to all players in the lobby.",

  async execute(ctx, args, gameState, bot) {
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
      ctx.deleteMessage().catch(() => { });
      return;
    }

    gameState.phase = "setup";

    await ctx.reply(
      `كل واحد فيكم غادي يوصلو الدور (Role) تاعو في 📨 <b>الخاص</b>.\n\n` +
        `⚠️ إذا مزال مابعثليش ميساج، أدخل للبروفايل تاعي وادعس على <b>Start</b>.`,
      { parse_mode: "HTML" },
    );

    // ── Group size calculation ────────────────────────────────────────
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
      `Starting setup for ${playerCount} players — ` +
        `${mafiaCount} Mafia, ${villagerCount} Village, ${neutralCount} Neutral`,
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
      log("SETUP", `  🔴 ${player.username} → ${roleName} (Mafia)`);
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
      log("SETUP", `  🟢 ${player.username} → ${roleName} (Village)`);
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
      log("SETUP", `  🔵 ${player.username} → ${roleName} (Neutral)`);

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
            `  🎯 Executioner target: ${gameState.players.get(targetId)?.username}`,
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

    // ── Send role DMs ─────────────────────────────────────────────────
    log(
      "SETUP",
      `Sending role cards to all ${gameState.players.size} players...`,
    );

    const dmResults = await Promise.all(
      Array.from(gameState.players.entries()).map(async ([userId, player]) => {
        const roleInfo = ROLES[player.role];
        if (!roleInfo) {
          err(
            "SETUP",
            `No role data found for role "${player.role}" — this is a bug`,
          );
          return {
            userId,
            username: player.username,
            success: false,
            error: `Unknown role: ${player.role}`,
          };
        }

        const result = await sendRoleCard(
          bot,
          userId,
          player.role,
          roleInfo,
          player.username,
        );
        if (!result.success) {
          return { userId, username: player.username, ...result };
        }

        if (player.align === "Mafia") {
          await sendMafiaTeamDM(
            bot,
            userId,
            gameState.mafiaPlayers,
            gameState.players,
            player.username,
          );
        }
        if (player.role === "Executioner" && rs.Executioner.target) {
          await sendExecutionerTargetDM(
            bot,
            userId,
            rs.Executioner.target,
            gameState.players,
            player.username,
          );
        }

        return { userId, username: player.username, success: true };
      }),
    );

    const failures = dmResults.filter((r) => !r.success);

    if (failures.length > 0) {
      const failList = failures.map((r) => `• ${r.username}`).join("\n");
      err(
        "SETUP",
        `Setup failed — couldn't reach: ${failures.map((r) => r.username).join(", ")}`,
      );
      rollbackSetup(gameState);
      await ctx.reply(
        `❌ <b>Setup failed!</b>\n\nPlayers who couldn't receive their role:\n${failList}\n\n` +
          `Have each listed player open a private chat with me (/start), then the host can run /setup again.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    gameState.gameReady = true;
    gameState.phase = "lobby";
    log("SETUP", `✅ Setup complete! Game is ready to start.`);

    const alignBreakdown =
      `🔴 Mafia: <b>${mafiaCount}</b>\n` +
      `🟢 Village: <b>${villagerCount}</b>\n` +
      `🔵 Neutral: <b>${neutralCount}</b>`;

    await ctx.reply(
      `✅ <b>Mafiaville راهي واجدة!</b>\n\n👥 <b>${playerCount} لاعبين</b> وزعنا عليهم الأدوار:\n${alignBreakdown}\n\n`,
      { parse_mode: "HTML" },
    );
  },
};
