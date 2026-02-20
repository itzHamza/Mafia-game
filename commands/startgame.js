/**
 * commands/startgame.js
 * Telegram command: /startgame
 *
 * FIXES APPLIED (v2):
 *
 *   nightActions() — throttled DM dispatch (FIX: Rate-limit / socket hang)
 *     Previously: Promise.all(promises) fired every DM simultaneously.
 *     With 10–16 players this created a burst of concurrent sendMessage calls
 *     that overwhelmed the socket pool, causing "network hanging" where all
 *     pending requests piled up and were delivered together minutes later.
 *
 *     Fix: replace Promise.all with a sequential loop that awaits each
 *     collectNightAction() call with a 120 ms inter-player delay. The total
 *     added latency for a 16-player game is ~1.9 s — imperceptible during a
 *     60 s night phase, but enough to keep Telegram's per-bot send rate
 *     (30 messages/second) and socket concurrency limits comfortable.
 *
 *     The results are still accumulated into roundByRole as before;
 *     the change is purely in how we fan-out the concurrent calls.
 *
 *   All other functions (dayTime, checkWin, etc.) are unchanged from v1.
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
// GROUP / DM HELPERS (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

async function toGroup(bot, groupChatId, text) {
  try {
    await bot.telegram.sendMessage(groupChatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("toGroup error:", err.message);
  }
}

async function dm(bot, userId, text) {
  try {
    await bot.telegram.sendMessage(userId, text, { parse_mode: "HTML" });
  } catch {
    /* player may have blocked the bot */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN CONDITION CHECKER (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

async function checkWin(deadId, afterVote, gameState, bot) {
  const neutralChecks = gameState.neutralPlayers.map((uid) =>
    checkNeutralWin(uid, deadId, afterVote, gameState, bot),
  );
  const results = await Promise.all(neutralChecks);

  for (const r of results) {
    if (r.won && r.exclusive) return ["neutral", true, r.role];
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

  if (mafia >= nonMafia) return ["mafia", true, coWins];
  if (mafia === 0) return ["village", true, coWins];
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
        await dm(
          bot,
          uid,
          `🃏 <b>Your target has died overnight.</b>\n\n` +
            `You have become the <b>Jester</b>. Your new goal: ` +
            `get <b>yourself</b> lynched at a Town Hall meeting.`,
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
// NIGHT ACTION COLLECTION — THROTTLED
//
// FIX: Rate-limit / socket hang
//
// Root cause of the original issue:
//   Promise.all() launched all collectNightAction() calls simultaneously.
//   Each call immediately sends a DM with an inline keyboard. With 10–16
//   players, this is 10–16 concurrent sendMessage API calls. Node's HTTP
//   agent has a default socket pool of 5 sockets. The excess requests queue
//   on the agent. If Telegram's server is slow (or if the bot has been
//   rate-limited), the queue backs up until the 90 s agent timeout fires
//   for some sockets, after which they all flush at once.
//
// Fix strategy — sequential fan-out with inter-player delay:
//   We iterate over alive players in order, fire collectNightAction() for
//   each one, and await it with a 120 ms pause between launches. The key
//   insight is that collectNightAction() itself is non-blocking after the
//   initial sendMessage: it registers a resolver in actionRegistry and
//   returns a Promise that is settled only when the player presses a button
//   or the night timer fires. So "awaiting" it does NOT mean we wait 60 s
//   per player sequentially; it means we fire the DM, wait 120 ms, fire the
//   next DM, wait 120 ms, etc. All action Promises run concurrently after
//   that point, collected into the `pendingActions` array and awaited together.
//
//   Timeline for 10 players with 120 ms delay:
//     t=0ms    Player 1 DM sent, Promise stored
//     t=120ms  Player 2 DM sent, Promise stored
//     ...
//     t=1080ms Player 10 DM sent, Promise stored
//     → All 10 Promises now running concurrently, total overhead ~1.1 s
//
//   This keeps us well under Telegram's 30-msg/s limit and avoids the socket
//   pool saturation that caused the hanging.
//
// NIGHT_DM_INTERVAL_MS is tunable via environment variable NIGHT_DM_INTERVAL
// so operators can adjust without a code change. Default: 120 ms.
// ─────────────────────────────────────────────────────────────────────────────

const NIGHT_DM_INTERVAL_MS = parseInt(
  process.env.NIGHT_DM_INTERVAL ?? "120",
  10,
);

async function nightActions(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;

  gameState.deadThisRound = [];
  gameState.nightActions.clear();
  actionRegistry.clear();

  // Night intro message (unchanged)
  const aliveLines = gameState.playersAlive
    .map((id) => {
      const p = gameState.players.get(id);
      return p && !p.silencedThisRound
        ? `• <a href="tg://user?id=${id}">${p.username}</a>`
        : null;
    })
    .filter(Boolean)
    .join("\n");

  await toGroup(
    bot,
    groupChatId,
    `🌙 <b>Night ${round} begins!</b>\n\n` +
      `Check your private messages for your action prompt. ` +
      `You have <b>${gameState.settings.nightTime}s</b> to respond.\n\n` +
      `<b>Leaving the meeting:</b>\n${aliveLines || "—"}`,
  );

  // ── THROTTLED FAN-OUT ─────────────────────────────────────────────────────
  // Step 1: launch each player's action collector with a delay between each.
  //         Collect the resulting Promises without awaiting them yet.
  // Step 2: await all Promises together so the night timer runs concurrently.
  //
  // Discord equivalent: promises.push(role.night(user).then(...))
  //                     + Promise.all(promises)
  // ─────────────────────────────────────────────────────────────────────────

  const roundByRole = new Map();
  const pendingActions = []; // Promises from all launched action collectors

  for (const [userId, player] of gameState.players) {
    if (!player.isAlive) continue;

    // Jailed players cannot act — notify immediately (no delay needed)
    if (gameState.roleState.Jailer.lastSelection === userId) {
      // Fire-and-forget — we don't stall the loop waiting for the DM to deliver
      dm(
        bot,
        userId,
        `⛓ <b>You were jailed tonight.</b>\n\n` +
          `You cannot perform your night action. ` +
          `Answer the Jailer's questions honestly — or risk execution.`,
      ).catch(() => {});
      continue;
    }

    // Launch the action collector (sends the DM with inline keyboard internally)
    const actionPromise = collectNightAction(bot, userId, round, gameState)
      .then((result) => {
        roundByRole.set(player.role, { action: result, actorId: userId });
      })
      .catch((err) => {
        console.error(
          `[nightActions] collectNightAction error for ${player.username} (${userId}):`,
          err.message,
        );
        // Graceful fallback: treat as no action taken
        roundByRole.set(player.role, { action: {}, actorId: userId });
      });

    pendingActions.push(actionPromise);

    // ── Inter-player throttle ──────────────────────────────────────────────
    // Pause between DM dispatches to avoid socket pool saturation.
    // This delay is applied AFTER kicking off the collector, not after waiting
    // for it to settle — so all action Promises are genuinely concurrent.
    if (NIGHT_DM_INTERVAL_MS > 0) {
      await sleepAsync(NIGHT_DM_INTERVAL_MS);
    }
  }

  // Step 2: wait for all pending action Promises to settle (player presses
  // button or night timer fires). This mirrors the original Promise.all().
  await Promise.all(pendingActions);

  await toGroup(
    bot,
    groupChatId,
    `🌙 <b>All actions received — processing results…</b>`,
  );

  await resolveNightActions(roundByRole, gameState, bot, groupChatId);

  // Store for Spy lookups in day phase
  gameState._lastRoundByRole = roundByRole;
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT TIME ORCHESTRATOR (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

async function nightTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  await sleepAsync(3000);
  gameState.phase = "night";

  await toGroup(
    bot,
    groupChatId,
    `🌙🏠 <b>Night ${round}</b> — The town goes quiet.\n\n` +
      `All players: check your <b>private messages</b> with me for your night action.\n` +
      `You have <b>${gameState.settings.nightTime} seconds</b> to respond.`,
  );

  await muteAll(bot, groupChatId, gameState);
  await nightActions(round, bot, gameState);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY TIME ORCHESTRATOR (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

async function dayTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  gameState.phase = "day";

  await sleepAsync(2000);

  // Update silenced flags
  for (const [, player] of gameState.players) {
    player.wasFramed = false;

    if (player.silencedLastRound) {
      player.silencedLastRound = false;
    }
    if (player.silencedThisRound) {
      player.silencedThisRound = false;
      player.silencedLastRound = true;
    }
  }

  const silencedNames = gameState.playersAlive
    .map((id) => gameState.players.get(id))
    .filter((p) => p && p.silencedLastRound)
    .map((p) => p.username);

  let moveAnnouncement = `☀️ <b>Day ${round} — Everyone heads to Town Hall.</b>`;
  if (silencedNames.length > 0) {
    moveAnnouncement += `\n\n🤫 <b>Absent (silenced):</b> ${silencedNames.join(", ")}`;
  }
  await toGroup(bot, groupChatId, moveAnnouncement);
  await updateDayPermissions(bot, groupChatId, gameState);

  await sleepAsync(1500);
  await announceNightResults(bot, gameState);

  let winResult = await checkWin(null, false, gameState, bot);
  if (winResult[1]) return winResult;

  const jailerId = gameState.roleState.Jailer.jailerId;
  if (jailerId && gameState.players.get(jailerId)?.isAlive) {
    collectJailerDay(bot, jailerId, round, gameState).catch(console.error);
  }

  await sleepAsync(1000);
  await announceDayAttendance(bot, gameState, round);

  await sleepAsync(1500);
  const nomineeId = await runNominationVote(bot, gameState, round);

  if (!nomineeId) {
    await toGroup(
      bot,
      groupChatId,
      `🤷 <b>The vote was inconclusive!</b>\n\nNo one received enough nominations.`,
    );
    return ["", false, []];
  }

  const nominee = gameState.players.get(nomineeId);
  await toGroup(
    bot,
    groupChatId,
    `⚖️ <b>The town has nominated ${nominee?.username ?? "?"}!</b>\n\n` +
      `<a href="tg://user?id=${nomineeId}">${nominee?.username ?? "?"}</a> has ` +
      `<b>${gameState.settings.votingTime} seconds</b> to make their case.\n\n` +
      `The execution vote will follow.`,
  );

  await sleepAsync(gameState.settings.votingTime * 1000);

  const execResult = await runExecutionVote(bot, gameState, round, nomineeId);
  await announceExecutionResult(bot, gameState, execResult);

  if (!execResult.executed) {
    return ["", false, []];
  }

  return checkWin(nomineeId, true, gameState, bot);
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN MESSAGE BUILDERS (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function buildWinMessage(winner, extra, gameState) {
  switch (winner) {
    case "mafia":
      return (
        `🔴 <b>The Mafia wins!</b>\n\n` +
        `The Mafia has brought about the total destruction of Mafiaville.\n` +
        `The town will truly never be the same… until the next game.`
      );
    case "village":
      return (
        `🟢 <b>The Village wins!</b>\n\n` +
        `The townspeople have vanquished the Mafiaville Mafia.\n` +
        `The village can sleep peacefully — at least until the next game.`
      );
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
      return (
        `🃏 <b>The Jester wins!</b>\n\n` +
        `${p ? `<b>${p.username}</b>` : "The Jester"} tricked you into lynching ` +
        `them. You thought they were suspicious — but you were the clowns all along!`
      );
    }
    case "Executioner": {
      const id = rs.Executioner.executionerId;
      const p = id ? gameState.players.get(id) : null;
      return (
        `⚖️ <b>The Executioner wins!</b>\n\n` +
        `${p ? `<b>${p.username}</b>` : "The Executioner"} tricked you into ` +
        `lynching their target. They were just an innocent villager ` +
        `the Executioner deeply hated.`
      );
    }
    case "Baiter": {
      const id = rs.Baiter.baiterId;
      const p = id ? gameState.players.get(id) : null;
      return (
        `💥 <b>The Baiter wins!</b>\n\n` +
        `${p ? `<b>${p.username}</b>` : "The Baiter"} baited ` +
        `<b>${rs.Baiter.baitedCount}</b> player(s) into their trap. ` +
        `Be more careful who you visit at night!`
      );
    }
    case "Arsonist": {
      const id = rs.Arsonist.arsonistId;
      const p = id ? gameState.players.get(id) : null;
      return (
        `🔥 <b>The Arsonist wins!</b>\n\n` +
        `${p ? `<b>${p.username}</b>` : "The Arsonist"} watched Mafiaville ` +
        `burn to the ground. Maybe establish a fire department next time?`
      );
    }
    default:
      return `🔵 <b>${role} wins!</b>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND (unchanged)
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
    const groupChatId = gameState.groupChatId;

    await ctx.reply(
      `🎲 <b>The game is starting!</b>\n\n` +
        `All announcements will appear here. Night and day prompts ` +
        `will arrive in your private messages with me.`,
      { parse_mode: "HTML" },
    );

    let gameOver = false;
    let winner = "";
    let extra = [];

    for (let round = 1; !gameOver; round++) {
      gameState.currentRound = round;

      await nightTime(round, bot, gameState);
      await sleepAsync(2000);

      const dayResult = await dayTime(round, bot, gameState);
      [winner, gameOver, extra] = dayResult;
      if (gameOver) break;

      if (gameState.playersAlive.length === 0) {
        gameOver = true;
        winner = "village";
        break;
      }

      console.log(`✅ Round ${round} completed.`);
      await sleepAsync(2000);
    }

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
          `<a href="tg://user?id=${p.id}">${p.username}</a>` +
          ` — <b>${p.role ?? "?"}</b> (${p.align ?? "?"})`,
      )
      .join("\n");

    await toGroup(
      bot,
      groupChatId,
      `📋 <b>Here's who everyone was:</b>\n\n${roleList}`,
    );

    const prevPlayers = new Map(gameState.players);
    gameState.reset(prevPlayers);

    await toGroup(
      bot,
      groupChatId,
      `🔄 <b>The lobby is open for another game!</b>\n\n` +
        `Use /setup when ready. Players can use /leave to drop out.`,
    );
  },
};
