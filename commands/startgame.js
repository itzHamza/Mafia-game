/**
 * commands/startgame.js
 */

"use strict";

const { collectNightAction } = require("../roles/nightPrompts");
const {
  resolveNightActions,
  notifyGodfatherSuccession,
} = require("../roles/nightResolver");
const actionRegistry = require("../roles/actionRegistry");
const {
  announceNightResults,
  announceDayAttendance,
} = require("../roles/dayAnnouncements");
const {
  runNominationVote,
  runExecutionVote,
  announceExecutionResult,
  collectJailerDay,
  clearActiveSessions,
} = require("../roles/dayVoting");
const {
  muteAll,
  updateDayPermissions,
  unmuteAll,
} = require("../roles/chatPermissions");
const { log, warn, err } = require("../logger");

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// GROUP / DM HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function toGroup(bot, groupChatId, text) {
  try {
    await bot.telegram.sendMessage(groupChatId, text, { parse_mode: "HTML" });
  } catch (e) {
    err("BOT", `Failed to send message to group chat: ${e.message}`);
  }
}

async function dm(bot, userId, text) {
  try {
    await bot.telegram.sendMessage(userId, text, { parse_mode: "HTML" });
  } catch (e) {
    err("BOT", `Failed to DM user ${userId}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN CONDITION CHECKER
// ─────────────────────────────────────────────────────────────────────────────

async function checkWin(deadId, afterVote, gameState, bot) {
  const neutralChecks = gameState.neutralPlayers.map((uid) =>
    checkNeutralWin(uid, deadId, afterVote, gameState, bot),
  );
  const results = await Promise.all(neutralChecks);

  for (const r of results) {
    if (r.won && r.exclusive) {
      log("GAME", `🏆 ${r.role} wins!`);
      return ["neutral", true, r.role];
    }
  }

  const coWins = results
    .filter((r) => r.won && !r.exclusive)
    .map((r) => r.role);

  let mafia = 0,
    nonMafia = 0;
  for (const [, p] of gameState.players) {
    if (!p.isAlive) continue;
    p.align === "Mafia" ? mafia++ : nonMafia++;
  }

  if (mafia >= nonMafia) {
    log("GAME", `🏆 Mafia wins! (${mafia} Mafia vs ${nonMafia} others alive)`);
    return ["mafia", true, coWins];
  }
  if (mafia === 0) {
    log("GAME", `🏆 Village wins! All Mafia eliminated.`);
    return ["village", true, coWins];
  }
  return ["", false, coWins];
}

async function checkNeutralWin(uid, deadId, afterVote, gameState, bot) {
  const player = gameState.players.get(uid);
  if (!player) return { role: "Unknown", won: false, exclusive: false };

  switch (player.role) {
    case "Jester":
      return {
        role: "Jester",
        won: uid === deadId && afterVote,
        exclusive: true,
      };

    case "Executioner": {
      const rs = gameState.roleState.Executioner;
      const targetAlive = gameState.players.get(rs.target)?.isAlive ?? false;

      if (!rs.isJester && !targetAlive && !afterVote) {
        rs.isJester = true;
        log(
          "GAME",
          `${player.username} (Executioner) becomes Jester — target died at night`,
        );
        await dm(
          bot,
          uid,
          `🃏 <b>Your target has died overnight.</b>\n\nYou have become the <b>Jester</b>. ` +
            `Your new goal: get <b>yourself</b> lynched at a Town Hall meeting.`,
        );
      }
      if (rs.isJester) {
        const won = uid === deadId && afterVote;
        if (won) rs.executionerId = uid;
        return { role: "Executioner", won, exclusive: true };
      }
      const won = rs.target === deadId && afterVote;
      if (won) rs.executionerId = uid;
      return { role: "Executioner", won, exclusive: true };
    }

    case "Baiter": {
      const rs = gameState.roleState.Baiter;
      const won = rs.baitedCount >= 3 && player.isAlive;
      if (won) rs.baiterId = uid;
      return { role: "Baiter", won, exclusive: false };
    }

    case "Arsonist": {
      const won = gameState.playersAlive.length === 1 && player.isAlive;
      if (won) gameState.roleState.Arsonist.arsonistId = uid;
      return { role: "Arsonist", won, exclusive: true };
    }

    default:
      return { role: player.role, won: false, exclusive: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

const NIGHT_DM_INTERVAL_MS = parseInt(
  process.env.NIGHT_DM_INTERVAL ?? "120",
  10,
);

async function nightActions(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  const alive = gameState.playersAlive.length;

  log("NIGHT", `--- Night ${round} begins (${alive} players alive) ---`);

  gameState.deadThisRound = [];
  gameState.nightActions.clear();
  actionRegistry.clear();

  // Night intro message
  const aliveLines = gameState.playersAlive
    .map((id) => {
      const p = gameState.players.get(id);
      return p ? `• <a href="tg://user?id=${id}">${p.username}</a>` : null;
    })
    .filter(Boolean)
    .join("\n");

  await toGroup(
    bot,
    groupChatId,
    `شوفو الميساجات (Private) باش ديرو واش لازم. ` +
      `عندكم <b>${gameState.settings.nightTime} ثانية</b> باش تجاوبو.\n\n` +
      `<b>اللي بقاو حيين:</b>\n${aliveLines || "—"}`,
  );

  // Fan-out night action prompts
  const roundByRole = new Map();
  const pendingActions = [];

  for (const [userId, player] of gameState.players) {
    if (!player.isAlive) continue;

    // Jailed players
    if (gameState.roleState.Jailer.lastSelection === userId) {
      log("NIGHT", `${player.username} is jailed tonight — no action`);
      dm(
        bot,
        userId,
        `⛓ <b>You were jailed tonight.</b>\n\nYou cannot perform your night action. ` +
          `Answer the Jailer's questions honestly — or risk execution.`,
      ).catch(() => {});
      continue;
    }

    log(
      "NIGHT",
      `Sending action prompt to ${player.username} (${player.role})`,
    );

    const actionPromise = collectNightAction(bot, userId, round, gameState)
      .then((result) => {
        const acted = result && Object.keys(result).length > 0;
        log(
          "NIGHT",
          `${player.username} ${acted ? "submitted their action" : "took no action"}`,
        );
        roundByRole.set(player.role, { action: result, actorId: userId });
      })
      .catch((e) => {
        err(
          "NIGHT",
          `Error collecting action from ${player.username}: ${e.message}`,
        );
        roundByRole.set(player.role, { action: {}, actorId: userId });
      });

    pendingActions.push(actionPromise);

    if (NIGHT_DM_INTERVAL_MS > 0) {
      await sleepAsync(NIGHT_DM_INTERVAL_MS);
    }
  }

  log("NIGHT", `Waiting for all ${pendingActions.length} players to act...`);
  await Promise.all(pendingActions);
  log("NIGHT", `All actions received — resolving night events`);

  await toGroup(bot, groupChatId, `🌙 <b>رانا نشوفو واش صرا...</b>`);

  await resolveNightActions(roundByRole, gameState, bot, groupChatId);

  gameState._lastRoundByRole = roundByRole;
  log("NIGHT", `--- Night ${round} complete ---`);
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT TIME ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

async function nightTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  await sleepAsync(3000);
  gameState.phase = "night";

  await toGroup(
    bot,
    groupChatId,
    `🌙🏠 <b>الليلة ${round}</b> — قاع المدينة رقدت.\n\n`,
  );

  await muteAll(bot, groupChatId, gameState);
  await nightActions(round, bot, gameState);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY TIME ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

async function dayTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  gameState.phase = "day";

  log("DAY", `--- Day ${round} begins ---`);
  await sleepAsync(2000);

  // Flip silenced flags
  for (const [, player] of gameState.players) {
    player.wasFramed = false;
    if (player.silencedLastRound) player.silencedLastRound = false;
    if (player.silencedThisRound) {
      player.silencedThisRound = false;
      player.silencedLastRound = true;
      log("DAY", `${player.username} is silenced today`);
    }
  }

  const silencedNames = gameState.playersAlive
    .map((id) => gameState.players.get(id))
    .filter((p) => p && p.silencedLastRound)
    .map((p) => p.username);

  let moveAnn = `☀️ <b>اليوم ${round} — ارواحو كامل للبطحة تاع الحومة.</b>`;
  if (silencedNames.length > 0) {
    moveAnn += `\n\n🤫 <b>غائبين (ممنوعين من الهدرة):</b> - ${silencedNames.join(", ")}`;
  }
  await toGroup(bot, groupChatId, moveAnn);

  await updateDayPermissions(bot, groupChatId, gameState);
  await sleepAsync(1500);

  await announceNightResults(bot, gameState);

  // Early win check (e.g. all mafia dead from night actions)
  let winResult = await checkWin(null, false, gameState, bot);
  if (winResult[1]) return winResult;

  // Jailer daytime prompt
  const jailerId = gameState.roleState.Jailer.jailerId;
  if (jailerId && gameState.players.get(jailerId)?.isAlive) {
    collectJailerDay(bot, jailerId, round, gameState).catch((e) => {
      err("DAY", `Jailer selection error: ${e.message}`);
    });
  }

  await sleepAsync(1000);
  await announceDayAttendance(bot, gameState, round);
  await sleepAsync(1500);

  log(
    "DAY",
    `Nomination vote started — players have ${gameState.settings.dayTime}s`,
  );
  const nomineeId = await runNominationVote(bot, gameState, round);

  if (!nomineeId) {
    log("DAY", "Vote inconclusive — no one reached the nomination threshold");
    await toGroup(
      bot,
      groupChatId,
      `🤷 <b>The vote was inconclusive!</b>\n\nNo one received enough nominations.`,
    );
    return ["", false, []];
  }

  const nominee = gameState.players.get(nomineeId);
  log("DAY", `${nominee?.username} has been nominated for execution`);

  await toGroup(
    bot,
    groupChatId,
    `⚖️ <b>The town has nominated ${nominee?.username ?? "?"}!</b>\n\n` +
      `<a href="tg://user?id=${nomineeId}">${nominee?.username ?? "?"}</a> has ` +
      `<b>${gameState.settings.votingTime} seconds</b> to make their case.\n\nThe execution vote will follow.`,
  );

  await sleepAsync(gameState.settings.votingTime * 1000);

  log("DAY", `Execution vote started for ${nominee?.username}`);
  const execResult = await runExecutionVote(bot, gameState, round, nomineeId);

  if (execResult.executed) {
    log("DAY", `${nominee?.username} was executed`);
  } else {
    log("DAY", `${nominee?.username} was acquitted`);
  }

  await announceExecutionResult(bot, gameState, execResult);

  if (!execResult.executed) return ["", false, []];

  return checkWin(nomineeId, true, gameState, bot);
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN MESSAGE BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildWinMessage(winner, extra, gameState) {
  switch (winner) {
    case "mafia":
      return `🔴 <b>العصابة هي اللي ربحت!</b>\n\nخلاص، العصابة سيطرت على الحومة وقضات على كامل سكانها.`;
    case "village":
      return `🟢 <b>ولاد الحومة هوما اللي ربحو!</b>\n\nالحق بان، وولاد الحومة قدروا يصفّيوها وينقّيو المنطقة من العصابة.`;
    case "neutral":
      return buildNeutralWinMessage(extra, gameState);
    default:
      return `🏁 <b>خلاصت اللعبة!</b>`;
  }
}

function buildNeutralWinMessage(role, gameState) {
  const rs = gameState.roleState;
  switch (role) {
    case "Jester": {
      const id = rs.Jester.jesterId ?? rs.Executioner.executionerId;
      const p = id ? gameState.players.get(id) : null;
      return `🃏 <b>البهلول هو اللي ربح!</b>\n\n${p ? `<b>${p.username}</b>` : "البهلول"} خلاكم تفوطيو عليه باش يموت.`;
    }
    case "Executioner": {
      const id = rs.Executioner.executionerId;
      const p = id ? gameState.players.get(id) : null;
      return `⚖️ <b>مول الكونترا هو اللي ربح!</b>\n\n${p ? `<b>${p.username}</b>` : "مول الكونترا"} لعبها بيكم وحرّشكم على "السيبل" تاعو حتى فوطيتو عليه.`;
    }
    case "Baiter": {
      const id = rs.Baiter.baiterId;
      const p = id ? gameState.players.get(id) : null;
      return `💥 <b>الجزار هو اللي ربح!</b>\n\n${p ? `<b>${p.username}</b>` : "الجزار"} طرطق البارود على <b>${rs.Baiter.baitedCount}</b> من الناس اللي جاو يديرو التقرعيج في دارو.`;
    }
    case "Arsonist": {
      const id = rs.Arsonist.arsonistId;
      const p = id ? gameState.players.get(id) : null;
      return `🔥 <b>مول النار هو اللي ربح!</b>\n\n${p ? `<b>${p.username}</b>` : "مول النار"} شعل النار في الحومة وقعد يفرج فيها وهي تتحرق.`;
    }
    default:
      return `🔵 <b>${role} هو اللي ربح!</b>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  name: "startgame",
  description: "Start the game after /setup has completed.",

  async execute(ctx, args, gameState, bot) {
    if (ctx.chat.type === "private") {
      return ctx.reply("⚠️ This command must be used in the group chat.");
    }
    if (!gameState.gameReady) {
      return ctx.reply("⚠️ Run /setup first to assign roles.");
    }
    if (gameState.isGameActive) {
      return ctx.reply("⚠️ A game is already in progress.");
    }

    const issuerId = ctx.from.id;
    const issuer = gameState.players.get(issuerId);
    const isAuthorized =
      (issuer && issuer.isHost) || ADMIN_IDS.includes(issuerId);

    if (!isAuthorized) {
      return ctx.reply("⚠️ Only the 👑 Host can start the game.");
    }

    gameState.groupChatId = ctx.chat.id;
    gameState.phase = "night";
    const groupChatId = gameState.groupChatId;

    log("GAME", `Game starting — ${gameState.players.size} players`);

    await ctx.reply(
      `🎲 <b>اللعبة بدات!</b>\n\n` +
        `قاع الإعلانات والنتائج يبانو هنا. ` +
        `مي الميساجات تاع الليل والنهار يوصلوكم عندي في الخاص (Private Message).`,
      { parse_mode: "HTML" },
    );

    // Fire game loop detached so button presses are processed immediately
    runGameLoop(groupChatId, gameState, bot).catch((e) => {
      err("GAME", `Fatal error in game loop: ${e.message}`);
      bot.telegram
        .sendMessage(
          groupChatId,
          "❌ A fatal error stopped the game. Use /endgame to reset.",
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DETACHED GAME LOOP
// ─────────────────────────────────────────────────────────────────────────────

async function runGameLoop(groupChatId, gameState, bot) {
  let gameOver = false;
  let winner = "";
  let extra = [];

  for (let round = 1; !gameOver; round++) {
    gameState.currentRound = round;
    log("GAME", `====== Round ${round} ======`);

    await nightTime(round, bot, gameState);
    await sleepAsync(2000);

    const dayResult = await dayTime(round, bot, gameState);
    [winner, gameOver, extra] = dayResult;

    if (gameOver) break;

    if (gameState.playersAlive.length === 0) {
      log("GAME", "All players are dead — Village wins by default");
      gameOver = true;
      winner = "village";
      break;
    }

    await sleepAsync(2000);
  }

  log("GAME", `Game over — Winner: ${winner}`);
  gameState.phase = "ended";
  gameState.gameReady = false;
  clearActiveSessions();
  actionRegistry.clear();

  await unmuteAll(bot, groupChatId, gameState);
  await toGroup(bot, groupChatId, buildWinMessage(winner, extra, gameState));

  if (Array.isArray(extra) && extra.length > 0) {
    for (const coWinRole of extra) {
      await sleepAsync(1500);
      await toGroup(
        bot,
        groupChatId,
        buildNeutralWinMessage(coWinRole, gameState),
      );
    }
  }

  await sleepAsync(2000);

  const roleList = Array.from(gameState.players.values())
    .map(
      (p) =>
        `<a href="tg://user?id=${p.id}">${p.username}</a> — <b>${p.role ?? "?"}</b> (${p.align ?? "?"})`,
    )
    .join("\n");

  await toGroup(
    bot,
    groupChatId,
    `📋 <b>Here's who everyone was:</b>\n\n${roleList}`,
  );

  const prevPlayers = new Map(gameState.players);
  gameState.reset(prevPlayers);
  log("GAME", "Game state reset — lobby is open for a new game");

  await toGroup(
    bot,
    groupChatId,
    `🔄 <b>The lobby is open for another game!</b>\n\nUse /setup when ready. Players can use /leave to drop out.`,
  );
}
