/**
 * commands/startgame.js
 * Telegram command: /startgame
 * Discord equivalent: commands/start.js → m.start
 *
 * Changes from Phase 4 stub:
 *   + Full dayTime() implementation (was a stub returning after sleepAsync)
 *   + Correct silenced-flag handling moved from nightTime() to dayTime()
 *   + Dead-player state correctly enforced via gameState flags
 *   + Jailer daytime prompt fired concurrently at day start
 *   + Nomination + execution votes wired in
 *   + Win-condition checks after voting
 *
 * Phase 4 bug fixed:
 *   nightTime() incorrectly converted silencedThisRound → silencedLastRound
 *   at the START of night, causing silencing to be active during the wrong
 *   round. The conversion now happens at the START of dayTime(), matching
 *   the original Discord bot's behaviour exactly.
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
// GROUP / DM HELPERS
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
// WIN CONDITION CHECKER
// Discord equivalent: function checkWin(dead, afterVote) in start.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number|null} deadId    UserId of last player who died, or null.
 * @param {boolean}     afterVote Was the death caused by a lynch vote?
 * @param {Object}      gameState
 * @param {Object}      bot
 * @returns {Promise<[string, boolean, string[]|string]>}
 *   ["mafia"|"village"|"neutral"|"", gameOver, extra]
 */
async function checkWin(deadId, afterVote, gameState, bot) {
  const neutralChecks = gameState.neutralPlayers.map((uid) =>
    checkNeutralWin(uid, deadId, afterVote, gameState, bot),
  );
  const results = await Promise.all(neutralChecks);

  // Exclusive neutral wins take priority (Jester, Executioner, Arsonist)
  for (const r of results) {
    if (r.won && r.exclusive) return ["neutral", true, r.role];
  }

  // Collect non-exclusive co-wins (Baiter)
  const coWins = results
    .filter((r) => r.won && !r.exclusive)
    .map((r) => r.role);

  // Standard Mafia/Village win
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

      // Target died at night → transition to Jester
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
// NIGHT ACTION COLLECTION
// Discord equivalent: function nightActions(roundNum) in start.js
// ─────────────────────────────────────────────────────────────────────────────

async function nightActions(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;

  gameState.deadThisRound = [];
  gameState.nightActions.clear();
  actionRegistry.clear();

  // Night intro
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

  // Collect all night actions concurrently
  // Discord equivalent: promises.push(role.night(user).then(result => roundByRole.set(...)))
  const roundByRole = new Map();
  const promises = [];

  for (const [userId, player] of gameState.players) {
    if (!player.isAlive) continue;

    // Jailed players cannot act
    if (gameState.roleState.Jailer.lastSelection === userId) {
      await dm(
        bot,
        userId,
        `⛓ <b>You were jailed tonight.</b>\n\n` +
          `You cannot perform your night action. ` +
          `Answer the Jailer's questions honestly — or risk execution.`,
      );
      continue;
    }

    promises.push(
      collectNightAction(bot, userId, round, gameState)
        .then((result) => {
          roundByRole.set(player.role, { action: result, actorId: userId });
        })
        .catch((err) => {
          console.error(
            `Night action error for ${player.username}:`,
            err.message,
          );
          roundByRole.set(player.role, { action: {}, actorId: userId });
        }),
    );
  }

  await Promise.all(promises);

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
// NIGHT TIME ORCHESTRATOR
// Discord equivalent: function nightTime(round) in start.js
//
// Phase 4 bug FIXED here:
//   REMOVED the silenced-flag conversion that was incorrectly placed here.
//   Flag conversion now happens at the START of dayTime() — matching the
//   original Discord bot where it ran at the start of dayTime().
// ─────────────────────────────────────────────────────────────────────────────

async function nightTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  await sleepAsync(3000);
  gameState.phase = "night";

  // ── "Players move to homes" announcement ─────────────────────────────────
  // Discord equivalent: member.voice.setChannel(player.vc) for each alive player
  // No voice in Telegram — announce the phase change.
  await toGroup(
    bot,
    groupChatId,
    `🌙🏠 <b>Night ${round}</b> — The town goes quiet.\n\n` +
      `All players: check your <b>private messages</b> with me for your night action.\n` +
      `You have <b>${gameState.settings.nightTime} seconds</b> to respond.`,
  );

  // Mute the group — all night communication happens via DM
  await muteAll(bot, groupChatId, gameState);

  await nightActions(round, bot, gameState);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY TIME ORCHESTRATOR
// Discord equivalent: function dayTime(round) in start.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<[string, boolean, any]>}  [winner, gameOver, extra]
 */
async function dayTime(round, bot, gameState) {
  const groupChatId = gameState.groupChatId;
  gameState.phase = "day";

  await sleepAsync(2000);

  // ── Step 1: Update silenced flags ─────────────────────────────────────────
  // Phase 4 bug fix: this was incorrectly placed in nightTime().
  // Discord equivalent: the player loop at the TOP of dayTime():
  //   if (silencedThisRound) { silence.apply(); silencedThisRound=false; silencedLastRound=true; }
  //   else if (silencedLastRound) { silence.remove(); silencedLastRound=false; }
  //
  // In Telegram, we have no channel restrictions to apply/remove —
  // we only update the boolean flags. The flags are checked in:
  //   • bot.js middleware  (drops group messages from silenced players)
  //   • dayVoting.js       (rejects votes from silenced players)
  //   • announceDayAttendance (shows silenced player as "absent")
  for (const [, player] of gameState.players) {
    player.wasFramed = false; // Reset framing from last night

    if (player.silencedLastRound) {
      // Un-silence: this player was silenced yesterday
      player.silencedLastRound = false;
    }
    if (player.silencedThisRound) {
      // Apply silence: this player was silenced last night → silent today
      player.silencedThisRound = false;
      player.silencedLastRound = true;
    }
  }

  // ── Step 2: "Move players to Town Hall" announcement ─────────────────────
  // Discord equivalent: member.voice.setChannel(townHall) for non-silenced alive players
  //   member.voice.setChannel(player.vc) for silenced players (kept home)
  //   member.voice.setChannel(ghostTown) for dead players
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

  // ── Step 3: Announce night results ────────────────────────────────────────
  // Discord equivalent: the for/switch loop over deadThisRound in dayTime()
  await sleepAsync(1500);
  await announceNightResults(bot, gameState);

  // ── Step 4: Check early win (before voting) ───────────────────────────────
  // Discord equivalent: checkWin("none", false).then(winResult => { if (winResult[1]) resolve(winResult) })
  let winResult = await checkWin(null, false, gameState, bot);
  if (winResult[1]) return winResult;

  // ── Step 5: Fire Jailer daytime prompt (non-blocking) ────────────────────
  // Discord equivalent: if (temp.role === "Jailer") { gamedata.villageRoles["Jailer"].prompt(member); }
  // Not awaited — runs concurrently alongside discussion/voting
  const jailerId = gameState.roleState.Jailer.jailerId;
  if (jailerId && gameState.players.get(jailerId)?.isAlive) {
    collectJailerDay(bot, jailerId, round, gameState).catch(console.error);
  }

  // ── Step 6: Post attendance ───────────────────────────────────────────────
  await sleepAsync(1000);
  await announceDayAttendance(bot, gameState, round);

  // ── Step 7: Nomination vote ───────────────────────────────────────────────
  // Discord equivalent: daytimeVoting() → first awaitReactions block
  await sleepAsync(1500);
  const nomineeId = await runNominationVote(bot, gameState, round);

  if (!nomineeId) {
    // Inconclusive — no one reached the threshold
    // Discord equivalent: "The vote was inconclusive!" channel.send
    await toGroup(
      bot,
      groupChatId,
      `🤷 <b>The vote was inconclusive!</b>\n\nNo one received enough nominations.`,
    );
    return ["", false, []];
  }

  // ── Step 8: Defence window ────────────────────────────────────────────────
  // Discord equivalent: "has X seconds to make their case" votingMsg
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

  // ── Step 9: Execution vote ────────────────────────────────────────────────
  // Discord equivalent: second awaitReactions block in daytimeVoting()
  const execResult = await runExecutionVote(bot, gameState, round, nomineeId);
  await announceExecutionResult(bot, gameState, execResult);

  if (!execResult.executed) {
    return ["", false, []];
  }

  // ── Step 10: Win check after execution ───────────────────────────────────
  // Discord equivalent: checkWin(result[1], true).then(winResult => resolve(winResult))
  return checkWin(nomineeId, true, gameState, bot);
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN MESSAGE BUILDERS
// Discord equivalent: the embed win messages + neutralRoles["X"].winMessage()
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
    const groupChatId = gameState.groupChatId;

    await ctx.reply(
      `🎲 <b>The game is starting!</b>\n\n` +
        `All announcements will appear here. Night and day prompts ` +
        `will arrive in your private messages with me.`,
      { parse_mode: "HTML" },
    );

    // ── Main game loop ────────────────────────────────────────────────────
    // Discord equivalent:
    //   for (let i = 1; nonmafia > mafia; i++) {
    //     await nightTime(i); dayTime(i).then(...); if (gameOver) break; }
    //
    // We check win at the end of each day rather than comparing raw counts
    // in the loop condition — this handles neutral wins correctly.
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

      // Safety valve: avoid infinite loop if all players somehow died
      if (gameState.playersAlive.length === 0) {
        gameOver = true;
        winner = "village";
        break;
      }

      console.log(`✅ Round ${round} completed.`);
      await sleepAsync(2000);
    }

    // ── End game ──────────────────────────────────────────────────────────
    gameState.phase = "ended";
    gameState.gameReady = false;
    clearActiveSessions();
    actionRegistry.clear();

    await unmuteAll(bot, groupChatId, gameState);
    await toGroup(bot, groupChatId, buildWinMessage(winner, extra, gameState));

    // Co-winner neutral announcements (e.g. Baiter co-wins with Village)
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

    // ── Final role summary ────────────────────────────────────────────────
    // Discord equivalent: channel.send(finalSummary embed)
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

    // ── Reset for next game ───────────────────────────────────────────────
    // Discord equivalent: return ["NEW GAME", gamedata.players]
    // which triggered: gamedata = new GameData(playersFromLastRound)
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
