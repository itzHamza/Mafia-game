/**
 * commands/setup.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const { ROLES, ALIGN_EMOJI } = require("../roles/roleData");
const IMAGES_DIR = path.join(__dirname, "..", "images");

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

const { log, warn, err } = require("../logger");

// ─────────────────────────────────────────────────────────────────────────────
// SHUFFLE UTILITY
// ─────────────────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE LIST BUILDER
//
// Returns an array of exactly N role-name strings following the rules:
//
//   N = 5  → Core 5 only (Mafioso + Doctor + Detective + Mayor + Distractor)
//   6–8    → Core 5 + Godfather + up-to-2 random Neutrals
//   N > 8  → Core 5 + Godfather
//             + 1–2 random Mafia extras  (Framer / Silencer)
//             + 1+ random Village extras (Vigilante / Jailer / PI / Spy)
//             + remaining filled with Neutrals (prefer ≤ 2)
//
// Constraint: Mafia total never exceeds floor(N / 3).
// ─────────────────────────────────────────────────────────────────────────────

function buildRoleList(n) {
  const MAFIA_EXTRAS = ["Framer", "Silencer"];
  const VILLAGE_EXTRAS = ["Vigilante", "Jailer", "PI", "Spy"];
  const NEUTRAL_POOL = ["Jester", "Executioner", "Baiter", "Arsonist"];

  // ── Core 5 (always) ──────────────────────────────────────────────────────
  const roles = ["Mafioso", "Doctor", "Detective", "Mayor", "Distractor"];

  if (n === 5) return roles;

  // ── N 6–8: Godfather + optional Neutrals ─────────────────────────────────
  roles.push("Godfather");

  if (n <= 8) {
    const neutralCount = Math.min(n - roles.length, 2);
    roles.push(...shuffle(NEUTRAL_POOL).slice(0, neutralCount));
    return roles;
  }

  // ── N > 8 ────────────────────────────────────────────────────────────────

  // Mafia expansion — stay under floor(N/3) cap
  const maxMafia = Math.floor(n / 3);
  const mafiaAdd = Math.min(MAFIA_EXTRAS.length, Math.max(0, maxMafia - 2));
  roles.push(...shuffle(MAFIA_EXTRAS).slice(0, mafiaAdd));

  // Helper: live slot count
  const slotsLeft = () => n - roles.length;

  // Village expansion — at least 1, leave room for Neutrals (prefer 2)
  const neutralBudget = Math.min(2, slotsLeft());
  const villageAdd = Math.max(
    1,
    Math.min(VILLAGE_EXTRAS.length, slotsLeft() - neutralBudget),
  );
  roles.push(...shuffle(VILLAGE_EXTRAS).slice(0, villageAdd));

  // Neutral fill — whatever slots remain, capped to pool size
  // (for N > 14 this may exceed 2 since we've exhausted other pools)
  const neutralCount = Math.min(NEUTRAL_POOL.length, slotsLeft());
  roles.push(...shuffle(NEUTRAL_POOL).slice(0, neutralCount));

  return roles;
}

// ─────────────────────────────────────────────────────────────────────────────
// ALIGNMENT MAPPER  (roleData uses Arabic; game logic uses English)
// ─────────────────────────────────────────────────────────────────────────────

const ALIGN_MAP = {
  العصابة: "Mafia",
  الحومة: "Village",
  محايد: "Neutral",
};

// ─────────────────────────────────────────────────────────────────────────────
// ROLE CARD FORMATTER
// ─────────────────────────────────────────────────────────────────────────────

function formatRoleCard(roleName, roleInfo) {
  const emoji = ALIGN_EMOJI[ALIGN_MAP[roleInfo.align]] ?? "⚪";
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
  rs.Jailer.killsLeft = 1;
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
    if (gameState.players.size < 5) {
      return ctx.reply(
        `⚠️ Not enough players! You need at least <b>5</b> to play.\nCurrent: <b>${gameState.players.size}</b>`,
        { parse_mode: "HTML" },
      );
    }
    if (gameState.phase === "setup") {
      return ctx.reply("⏳ Setup is already in progress.");
    }
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

    await ctx.reply(
      `كل واحد فيكم غادي يوصلو الدور (Role) تاعو في 📨 <b>الخاص</b>.\n\n` +
        `⚠️ إذا مزال مابعثليش ميساج، أدخل للبروفايل تاعي وادعس على <b>Start</b>.`,
      { parse_mode: "HTML" },
    );

    // ── Build & assign roles ────────────────────────────────────────────
    const playerCount = gameState.players.size;

    log("SETUP", `Building role list for ${playerCount} players...`);
    const roleList = shuffle(buildRoleList(playerCount));
    const playerIds = shuffle(Array.from(gameState.players.keys()));

    if (roleList.length !== playerCount) {
      err(
        "SETUP",
        `Role list length (${roleList.length}) does not match player count (${playerCount}) — aborting`,
      );
      rollbackSetup(gameState);
      return ctx.reply(
        "❌ <b>Setup failed!</b> Role count mismatch. Please try again.",
        { parse_mode: "HTML" },
      );
    }

    gameState.playersAlive = Array.from(gameState.players.keys());

    for (let i = 0; i < playerIds.length; i++) {
      const userId = playerIds[i];
      const roleName = roleList[i];
      const roleInfo = ROLES[roleName];
      const player = gameState.players.get(userId);
      const align = ALIGN_MAP[roleInfo.align] ?? "Neutral";

      player.role = roleName;
      player.align = align;

      if (align === "Mafia") {
        if (
          Object.prototype.hasOwnProperty.call(gameState.currentMafia, roleName)
        ) {
          gameState.currentMafia[roleName] = userId;
        }
        gameState.mafiaPlayers.push(userId);
      } else if (align === "Village") {
        gameState.villagePlayers.push(userId);
      } else {
        gameState.neutralPlayers.push(userId);
      }

      log(
        "SETUP",
        `  ${align === "Mafia" ? "🔴" : align === "Village" ? "🟢" : "🔵"} ${player.username} → ${roleName} (${align})`,
      );
    }

    const mafiaCount = gameState.mafiaPlayers.length;
    const villageCount = gameState.villagePlayers.length;
    const neutralCount = gameState.neutralPlayers.length;

    log(
      "SETUP",
      `Distribution — Mafia: ${mafiaCount}, Village: ${villageCount}, Neutral: ${neutralCount}`,
    );

    // ── Populate roleState IDs ──────────────────────────────────────────
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

    // ── Executioner target ──────────────────────────────────────────────
    for (const [userId, player] of gameState.players) {
      if (player.role !== "Executioner") continue;

      rs.Executioner.executionerId = userId;
      const eligible = gameState.villagePlayers.filter(
        (id) => gameState.players.get(id)?.role !== "Mayor",
      );
      if (eligible.length > 0) {
        const targetId = eligible[Math.floor(Math.random() * eligible.length)];
        rs.Executioner.target = targetId;
        log(
          "SETUP",
          `  🎯 Executioner target: ${gameState.players.get(targetId)?.username}`,
        );
      }
      break;
    }

    // ── Send role DMs ───────────────────────────────────────────────────
    log("SETUP", `Sending role cards to all ${playerCount} players...`);

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
        if (!result.success)
          return { userId, username: player.username, ...result };

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
      return ctx.reply(
        `❌ <b>Setup failed!</b>\n\nPlayers who couldn't receive their role:\n${failList}\n\n` +
          `Have each listed player open a private chat with me (/start), then the host can run /setup again.`,
        { parse_mode: "HTML" },
      );
    }

    gameState.gameReady = true;
    gameState.phase = "lobby";
    log("SETUP", `✅ Setup complete! Game is ready to start.`);

    const alignBreakdown =
      `🔴 العصابة (Mafia): <b>${mafiaCount}</b>\n` +
      `🟢 الحومة (Village): <b>${villageCount}</b>\n` +
      `🔵 محايد (Neutral): <b>${neutralCount}</b>`;

    await ctx.reply(
      `✅ <b>Mafiaville راهي واجدة!</b>\n\n` +
        `👥 <b>${playerCount} لاعبين</b> وزعنا عليهم الأدوار:\n${alignBreakdown}\n\n` +
        `الريس يدعس /startgame باش تبدا اللعبة!`,
      { parse_mode: "HTML" },
    );
  },
};
