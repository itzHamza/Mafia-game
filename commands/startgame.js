/**
 * commands/startgame.js — DEBUG BUILD
 *
 * Every Telegram API call is individually timed and logged.
 * The nightActions function logs each DM send so you can see exactly
 * which player's sendMessage call hangs and for how long.
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

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG LOGGER (same format as bot.js so logs interleave cleanly)
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
// GROUP / DM HELPERS — both now log call duration
// ─────────────────────────────────────────────────────────────────────────────

async function toGroup(bot, groupChatId, text) {
  const preview = text.replace(/<[^>]+>/g, "").slice(0, 60);
  log("TO-GROUP", `Sending to chat=${groupChatId} "${preview}"`);
  const t = Date.now();
  try {
    await bot.telegram.sendMessage(groupChatId, text, { parse_mode: "HTML" });
    log("TO-GROUP", `Done in ${Date.now() - t}ms`);
  } catch (e) {
    err("TO-GROUP", `Failed after ${Date.now() - t}ms — ${e.message}`);
  }
}

async function dm(bot, userId, text) {
  const preview = text.replace(/<[^>]+>/g, "").slice(0, 60);
  log("DM", `→ userId=${userId} "${preview}"`);
  const t = Date.now();
  try {
    await bot.telegram.sendMessage(userId, text, { parse_mode: "HTML" });
    log("DM", `✓ userId=${userId} in ${Date.now() - t}ms`);
  } catch (e) {
    err("DM", `✗ userId=${userId} after ${Date.now() - t}ms — ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN CONDITION CHECKER
// ─────────────────────────────────────────────────────────────────────────────

async function checkWin(deadId, afterVote, gameState, bot) {
  log("WIN", `checkWin deadId=${deadId} afterVote=${afterVote}`);
  const neutralChecks = gameState.neutralPlayers.map((uid) =>
    checkNeutralWin(uid, deadId, afterVote, gameState, bot),
  );
  const results = await Promise.all(neutralChecks);

  for (const r of results) {
    if (r.won && r.exclusive) {
      log("WIN", `NEUTRAL WIN — role=${r.role}`);
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

  log("WIN", `Alive count: mafia=${mafia} nonMafia=${nonMafia}`);

  if (mafia >= nonMafia) {
    log("WIN", "MAFIA WIN");
    return ["mafia", true, coWins];
  }
  if (mafia === 0) {
    log("WIN", "VILLAGE WIN");
    return ["village", true, coWins];
  }
  log("WIN", "No winner yet");
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
        log("WIN", `Executioner uid=${uid} becomes Jester`);
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
// NIGHT ACTION COLLECTION — THROTTLED WITH PER-PLAYER TIMING
//
// Key log lines to watch for when diagnosing hangs:
//   [NIGHT-DM] LAUNCH userId=XXX  — we're about to send the DM to this player
//   [NIGHT-DM] SENT   userId=XXX  — sendMessage returned (look at the ms value)
//   [NIGHT-DM] ACTION userId=XXX  — player pressed a button (or timed out)
//
// If you see "LAUNCH" without a matching "SENT" for minutes, the sendMessage
// call to that specific userId is hanging at the HTTP layer.
// ─────────────────────────────────────────────────────────────────────────────

const NIGHT_DM_INTERVAL_MS = parseInt(
  process.env.NIGHT_DM_INTERVAL ?? "120",
  10,
);

async function nightActions(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  log(
    "NIGHT",
    `=== nightActions START round=${round} playersAlive=${gameState.playersAlive.length} ===`,
  );

  gameState.deadThisRound = [];
  gameState.nightActions.clear();
  actionRegistry.clear();
  log("NIGHT", "State cleared, registry cleared");

  // Night intro
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
    `🌙 <b>Night ${round} begins!</b>\n\nCheck your private messages for your action prompt. ` +
      `You have <b>${gameState.settings.nightTime}s</b> to respond.\n\n` +
      `<b>Leaving the meeting:</b>\n${aliveLines || "—"}`,
  );

  // ── THROTTLED FAN-OUT ─────────────────────────────────────────────────────
  const roundByRole = new Map();
  const pendingActions = [];

  log(
    "NIGHT",
    `Starting per-player DM loop (interval=${NIGHT_DM_INTERVAL_MS}ms)`,
  );

  for (const [userId, player] of gameState.players) {
    if (!player.isAlive) {
      log(
        "NIGHT-DM",
        `SKIP userId=${userId} username=${player.username} (dead)`,
      );
      continue;
    }

    // Jailed players
    if (gameState.roleState.Jailer.lastSelection === userId) {
      log(
        "NIGHT-DM",
        `JAILED userId=${userId} username=${player.username} — sending jail notice`,
      );
      dm(
        bot,
        userId,
        `⛓ <b>You were jailed tonight.</b>\n\nYou cannot perform your night action. ` +
          `Answer the Jailer's questions honestly — or risk execution.`,
      ).catch(() => {});
      continue;
    }

    log(
      "NIGHT-DM",
      `LAUNCH userId=${userId} username=${player.username} role=${player.role}`,
    );
    const launchTime = Date.now();

    const actionPromise = collectNightAction(bot, userId, round, gameState)
      .then((result) => {
        const elapsed = Date.now() - launchTime;
        log(
          "NIGHT-DM",
          `ACTION userId=${userId} username=${player.username} role=${player.role} ` +
            `result=${JSON.stringify(result)} elapsed=${elapsed}ms`,
        );
        roundByRole.set(player.role, { action: result, actorId: userId });
      })
      .catch((e) => {
        const elapsed = Date.now() - launchTime;
        err(
          "NIGHT-DM",
          `ERROR userId=${userId} role=${player.role} after ${elapsed}ms — ${e.message}`,
        );
        roundByRole.set(player.role, { action: {}, actorId: userId });
      });

    pendingActions.push(actionPromise);

    if (NIGHT_DM_INTERVAL_MS > 0) {
      log(
        "NIGHT-DM",
        `Throttle pause ${NIGHT_DM_INTERVAL_MS}ms before next player`,
      );
      await sleepAsync(NIGHT_DM_INTERVAL_MS);
    }
  }

  log(
    "NIGHT",
    `All ${pendingActions.length} action Promises launched — awaiting resolution...`,
  );
  const waitStart = Date.now();
  await Promise.all(pendingActions);
  log("NIGHT", `All actions resolved in ${Date.now() - waitStart}ms total`);

  await toGroup(
    bot,
    groupChatId,
    `🌙 <b>All actions received — processing results…</b>`,
  );

  log("NIGHT", "Calling resolveNightActions...");
  const resolveStart = Date.now();
  await resolveNightActions(roundByRole, gameState, bot, groupChatId);
  log("NIGHT", `resolveNightActions done in ${Date.now() - resolveStart}ms`);

  gameState._lastRoundByRole = roundByRole;
  log("NIGHT", `=== nightActions END round=${round} ===`);
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT TIME ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

async function nightTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  log("NIGHT", `nightTime start round=${round}`);
  await sleepAsync(3000);
  gameState.phase = "night";
  log("NIGHT", `phase set to "night" round=${round}`);

  await toGroup(
    bot,
    groupChatId,
    `🌙🏠 <b>Night ${round}</b> — The town goes quiet.\n\n` +
      `All players: check your <b>private messages</b> with me for your night action.\n` +
      `You have <b>${gameState.settings.nightTime} seconds</b> to respond.`,
  );

  log("NIGHT", "Calling muteAll...");
  const muteStart = Date.now();
  await muteAll(bot, groupChatId, gameState);
  log("NIGHT", `muteAll done in ${Date.now() - muteStart}ms`);

  await nightActions(round, bot, gameState);
  log("NIGHT", `nightTime complete round=${round}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY TIME ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

async function dayTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  log("DAY", `dayTime start round=${round}`);
  gameState.phase = "day";
  log("DAY", `phase set to "day" round=${round}`);

  await sleepAsync(2000);

  // Update silenced flags
  for (const [, player] of gameState.players) {
    player.wasFramed = false;
    if (player.silencedLastRound) player.silencedLastRound = false;
    if (player.silencedThisRound) {
      player.silencedThisRound = false;
      player.silencedLastRound = true;
      log("DAY", `Silence applied to username=${player.username}`);
    }
  }

  const silencedNames = gameState.playersAlive
    .map((id) => gameState.players.get(id))
    .filter((p) => p && p.silencedLastRound)
    .map((p) => p.username);

  let moveAnn = `☀️ <b>Day ${round} — Everyone heads to Town Hall.</b>`;
  if (silencedNames.length > 0) {
    moveAnn += `\n\n🤫 <b>Absent (silenced):</b> ${silencedNames.join(", ")}`;
    log("DAY", `Silenced this round: ${silencedNames.join(", ")}`);
  }
  await toGroup(bot, groupChatId, moveAnn);

  log("DAY", "Calling updateDayPermissions...");
  const permStart = Date.now();
  await updateDayPermissions(bot, groupChatId, gameState);
  log("DAY", `updateDayPermissions done in ${Date.now() - permStart}ms`);

  await sleepAsync(1500);

  log("DAY", "Calling announceNightResults...");
  const annStart = Date.now();
  await announceNightResults(bot, gameState);
  log("DAY", `announceNightResults done in ${Date.now() - annStart}ms`);

  log("DAY", "Early win check...");
  let winResult = await checkWin(null, false, gameState, bot);
  if (winResult[1]) {
    log("DAY", `Early win: ${winResult[0]}`);
    return winResult;
  }

  // Jailer daytime prompt
  const jailerId = gameState.roleState.Jailer.jailerId;
  if (jailerId && gameState.players.get(jailerId)?.isAlive) {
    log("DAY", `Firing Jailer daytime prompt jailerId=${jailerId}`);
    collectJailerDay(bot, jailerId, round, gameState).catch((e) => {
      err("DAY", `collectJailerDay error — ${e.message}`);
    });
  }

  await sleepAsync(1000);

  log("DAY", "Posting attendance...");
  await announceDayAttendance(bot, gameState, round);

  await sleepAsync(1500);

  log("DAY", `Starting nomination vote dayTime=${gameState.settings.dayTime}s`);
  const nomStart = Date.now();
  const nomineeId = await runNominationVote(bot, gameState, round);
  log(
    "DAY",
    `Nomination vote done in ${Date.now() - nomStart}ms nomineeId=${nomineeId}`,
  );

  if (!nomineeId) {
    log("DAY", "Vote inconclusive — no nominee reached threshold");
    await toGroup(
      bot,
      groupChatId,
      `🤷 <b>The vote was inconclusive!</b>\n\nNo one received enough nominations.`,
    );
    return ["", false, []];
  }

  const nominee = gameState.players.get(nomineeId);
  log("DAY", `Nominee: ${nominee?.username} (${nomineeId})`);
  await toGroup(
    bot,
    groupChatId,
    `⚖️ <b>The town has nominated ${nominee?.username ?? "?"}!</b>\n\n` +
      `<a href="tg://user?id=${nomineeId}">${nominee?.username ?? "?"}</a> has ` +
      `<b>${gameState.settings.votingTime} seconds</b> to make their case.\n\nThe execution vote will follow.`,
  );

  log("DAY", `Defence window: ${gameState.settings.votingTime}s`);
  await sleepAsync(gameState.settings.votingTime * 1000);

  log("DAY", "Starting execution vote...");
  const execStart = Date.now();
  const execResult = await runExecutionVote(bot, gameState, round, nomineeId);
  log(
    "DAY",
    `Execution vote done in ${Date.now() - execStart}ms executed=${execResult.executed}`,
  );

  await announceExecutionResult(bot, gameState, execResult);

  if (!execResult.executed) {
    log("DAY", "Acquitted — no execution");
    return ["", false, []];
  }

  log("DAY", `Executed ${nominee?.username} — post-execution win check`);
  return checkWin(nomineeId, true, gameState, bot);
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN MESSAGE BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildWinMessage(winner, extra, gameState) {
  switch (winner) {
    case "mafia":
      return `🔴 <b>The Mafia wins!</b>\n\nThe Mafia has brought about the total destruction of Mafiaville.`;
    case "village":
      return `🟢 <b>The Village wins!</b>\n\nThe townspeople have vanquished the Mafiaville Mafia.`;
    case "neutral":
      return buildNeutralWinMessage(extra, gameState);
    default:
      return `🏁 <b>Game over!</b>`;
  }
}

function buildNeutralWinMessage(role, gameState) {
  const rs = gameState.roleState;
  switch (role) {
    case "Jester": {
      const id = rs.Jester.jesterId ?? rs.Executioner.executionerId;
      const p = id ? gameState.players.get(id) : null;
      return `🃏 <b>The Jester wins!</b>\n\n${p ? `<b>${p.username}</b>` : "The Jester"} tricked you into lynching them.`;
    }
    case "Executioner": {
      const id = rs.Executioner.executionerId;
      const p = id ? gameState.players.get(id) : null;
      return `⚖️ <b>The Executioner wins!</b>\n\n${p ? `<b>${p.username}</b>` : "The Executioner"} tricked you into lynching their target.`;
    }
    case "Baiter": {
      const id = rs.Baiter.baiterId;
      const p = id ? gameState.players.get(id) : null;
      return `💥 <b>The Baiter wins!</b>\n\n${p ? `<b>${p.username}</b>` : "The Baiter"} baited <b>${rs.Baiter.baitedCount}</b> players.`;
    }
    case "Arsonist": {
      const id = rs.Arsonist.arsonistId;
      const p = id ? gameState.players.get(id) : null;
      return `🔥 <b>The Arsonist wins!</b>\n\n${p ? `<b>${p.username}</b>` : "The Arsonist"} watched Mafiaville burn.`;
    }
    default:
      return `🔵 <b>${role} wins!</b>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  name: "startgame",
  description: "Start the game after /setup has completed.",

  async execute(ctx, args, gameState, bot) {
    log("STARTGAME", `Invoked by from=${ctx.from.id}`);

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
    gameState.phase = "night"; // or "day", depending on context
    const groupChatId = gameState.groupChatId;

    log(
      "STARTGAME",
      `Game starting — groupChatId=${groupChatId} players=${gameState.players.size}`,
    );

    // ── CRITICAL: reply immediately, then fire the game loop detached ─────────
    // Telegraf processes ONE update at a time. If we await the entire game loop
    // inside the handler, all callback_query updates (button presses) pile up
    // in Telegram's queue and are only delivered after the handler returns —
    // causing the "buttons do nothing until game ends" bug.
    //
    // Solution: respond to the command synchronously, then start the loop with
    // a plain .catch() so the handler returns and Telegraf is free to process
    // incoming updates (button presses, messages) immediately.
    // ─────────────────────────────────────────────────────────────────────────

    await ctx.reply(
      `🎲 <b>The game is starting!</b>\n\nAll announcements will appear here. ` +
        `Night and day prompts will arrive in your private messages with me.`,
      { parse_mode: "HTML" },
    );

    log(
      "STARTGAME",
      "Handler returning — game loop running detached in background",
    );

    // ── fire-and-forget: do NOT await this ────────────────────────────────────
    runGameLoop(groupChatId, gameState, bot).catch((e) => {
      err("STARTGAME", `Unhandled game loop error — ${e.stack ?? e.message}`);
      bot.telegram
        .sendMessage(
          groupChatId,
          "❌ A fatal error stopped the game. Use /endgame to reset.",
          {
            parse_mode: "HTML",
          },
        )
        .catch(() => {});
    });

    // Handler returns here — Telegraf is now free to process button presses
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DETACHED GAME LOOP
// Called without await from the command handler so Telegraf's middleware chain
// is released immediately and can process callback_query updates (button presses)
// while the game is running.
// ─────────────────────────────────────────────────────────────────────────────

async function runGameLoop(groupChatId, gameState, bot) {
  let gameOver = false;
  let winner = "";
  let extra = [];

  for (let round = 1; !gameOver; round++) {
    gameState.currentRound = round;
    log("STARTGAME", `=== ROUND ${round} BEGIN ===`);

    await nightTime(round, bot, gameState);
    await sleepAsync(2000);

    const dayResult = await dayTime(round, bot, gameState);
    [winner, gameOver, extra] = dayResult;

    log(
      "STARTGAME",
      `Round ${round} result: winner="${winner}" gameOver=${gameOver}`,
    );

    if (gameOver) break;

    if (gameState.playersAlive.length === 0) {
      log("STARTGAME", "All players dead — forcing village win");
      gameOver = true;
      winner = "village";
      break;
    }

    log("STARTGAME", `=== ROUND ${round} END — continuing ===`);
    await sleepAsync(2000);
  }

  log("STARTGAME", `Game over — winner="${winner}"`);
  gameState.phase = "ended";
  gameState.gameReady = false;
  clearActiveSessions();
  actionRegistry.clear();

  log("STARTGAME", "Calling unmuteAll...");
  const unmuteStart = Date.now();
  await unmuteAll(bot, groupChatId, gameState);
  log("STARTGAME", `unmuteAll done in ${Date.now() - unmuteStart}ms`);

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
  log("STARTGAME", "Resetting game state...");
  gameState.reset(prevPlayers);
  log("STARTGAME", "State reset complete");

  await toGroup(
    bot,
    groupChatId,
    `🔄 <b>The lobby is open for another game!</b>\n\nUse /setup when ready. Players can use /leave to drop out.`,
  );

  log("STARTGAME", "runGameLoop complete");
}
