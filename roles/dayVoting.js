/**
 * roles/dayVoting.js
 *
 * Day-phase voting: nomination vote, execution vote, and Jailer's
 * daytime jail-selection prompt.
 */

"use strict";

const { sendSelectionPrompt } = require("./nightPrompts");
const actionRegistry = require("./actionRegistry");

// ─────────────────────────────────────────────────────────────────────────────
// SESSION CLASSES
// ─────────────────────────────────────────────────────────────────────────────

class NominationSession {
  constructor(round, gameState, bot, threshold, resolve) {
    this.round = round;
    this.gameState = gameState;
    this.bot = bot;
    this.threshold = threshold;
    this.resolve = resolve;
    this.timer = null;
    this.messageId = null;
    this.votes = new Map(); // voterId → targetId
  }

  tally() {
    const counts = new Map();
    const mayorId = this.gameState.mayor;
    const mayorAlive =
      mayorId &&
      this.gameState.players.get(mayorId)?.isAlive &&
      this.gameState.roleState.Mayor.revealed;

    for (const [voterId, targetId] of this.votes) {
      const weight = mayorAlive && voterId === mayorId ? 2 : 1;
      counts.set(targetId, (counts.get(targetId) ?? 0) + weight);
    }
    return counts;
  }

  checkThreshold() {
    const counts = this.tally();
    let topId = null;
    let topVotes = 0;
    let uniqueTop = true;

    for (const [targetId, count] of counts) {
      if (count > topVotes) {
        topVotes = count;
        topId = targetId;
        uniqueTop = true;
      } else if (count === topVotes) {
        uniqueTop = false;
      }
    }

    if (!uniqueTop || topVotes < this.threshold) return null;
    return topId;
  }

  buildMessageText() {
    const counts = this.tally();
    const players = this.gameState.playersAlive
      .map((id, i) => {
        const p = this.gameState.players.get(id);
        if (!p) return null;
        const votes = counts.get(id) ?? 0;
        const bar = votes > 0 ? ` — ${"🟦".repeat(votes)} (${votes})` : "";
        return `${this.gameState.emojiArray[i]} ${p.username}${bar}`;
      })
      .filter(Boolean)
      .join("\n");

    return (
      `🗳 <b>Nomination vote — Round ${this.round}</b>\n\n` +
      `Press a button to nominate a player.\n` +
      `You need <b>${this.threshold}</b> votes to nominate someone.\n\n` +
      `${players}\n\n` +
      `<i>You have ${this.gameState.settings.dayTime}s to discuss and vote.</i>`
    );
  }

  end(result) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const fn = this.resolve;
    this.resolve = null;
    if (fn) fn(result);
  }
}

class ExecutionSession {
  constructor(round, nomineeId, gameState, resolve) {
    this.round = round;
    this.nomineeId = nomineeId;
    this.gameState = gameState;
    this.resolve = resolve;
    this.timer = null;
    this.messageId = null;
    this.votes = new Map(); // voterId → "guilty" | "innocent"
  }

  tally() {
    const mayorId = this.gameState.mayor;
    const mayorAlive =
      mayorId &&
      this.gameState.players.get(mayorId)?.isAlive &&
      this.gameState.roleState.Mayor.revealed;

    let yay = 0,
      nay = 0;
    const yayVoters = [],
      nayVoters = [];

    for (const [voterId, choice] of this.votes) {
      const isMayor = mayorAlive && voterId === mayorId;
      const weight = isMayor ? 2 : 1;
      if (choice === "guilty") {
        yay += weight;
        yayVoters.push(voterId);
      } else {
        nay += weight;
        nayVoters.push(voterId);
      }
    }

    return { yay, nay, yayVoters, nayVoters };
  }

  buildMessageText() {
    const nominee = this.gameState.players.get(this.nomineeId);
    const { yay, nay } = this.tally();

    // BUG FIX: original used Discord mention syntax <@userId> inside HTML parse_mode.
    // Telegram rejects <@number> as an unsupported HTML tag → 400 Bad Request,
    // which caused the entire execution vote message to fail to send.
    // Fix: use Telegram's inline mention format instead.
    const nomineeMention = nominee
      ? `<a href="tg://user?id=${this.nomineeId}">${nominee.username}</a>`
      : "?";

    return (
      `⚖️ <b>${nominee?.username ?? "?"} has been nominated!</b>\n\n` +
      `${nomineeMention} has <b>${this.gameState.settings.votingTime}s</b> to make their case.\n\n` +
      `✅ Guilty: <b>${yay}</b>   ❌ Innocent: <b>${nay}</b>\n\n` +
      `<i>The nominee cannot vote for themselves.</i>`
    );
  }

  end(result) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const fn = this.resolve;
    this.resolve = null;
    if (fn) fn(result);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-LEVEL ACTIVE SESSIONS
// ─────────────────────────────────────────────────────────────────────────────

let _nomSession = null;
let _execSession = null;

// ─────────────────────────────────────────────────────────────────────────────
// VOTE RECEIVERS — called from bot.js action handlers
// ─────────────────────────────────────────────────────────────────────────────

async function receiveNominationVote(voterId, targetId, ctx, gameState, bot) {
  if (!_nomSession) return;

  const voter = gameState.players.get(voterId);
  if (!voter || !voter.isAlive) {
    return ctx.answerCbQuery("⚠️ Only alive players can vote.").catch(() => {});
  }
  if (voter.silencedLastRound) {
    return ctx
      .answerCbQuery("🤫 You were silenced and cannot vote today.")
      .catch(() => {});
  }
  if (!gameState.playersAlive.includes(targetId)) {
    return ctx.answerCbQuery("⚠️ That player is not eligible.").catch(() => {});
  }

  const prev = _nomSession.votes.get(voterId);
  const changed = prev !== undefined;
  _nomSession.votes.set(voterId, targetId);

  const target = gameState.players.get(targetId);
  await ctx
    .answerCbQuery(
      changed
        ? `🔄 Changed vote to ${target?.username ?? "?"}`
        : `✅ Voted for ${target?.username ?? "?"}`,
    )
    .catch(() => {});

  if (_nomSession.messageId) {
    await bot.telegram
      .editMessageText(
        gameState.groupChatId,
        _nomSession.messageId,
        undefined,
        _nomSession.buildMessageText(),
        {
          parse_mode: "HTML",
          reply_markup: _buildNomKeyboard(gameState, _nomSession.round),
        },
      )
      .catch(() => {});
  }

  const nominee = _nomSession.checkThreshold();
  if (nominee !== null) {
    _nomSession.end(nominee);
    _nomSession = null;
  }
}

async function receiveExecutionVote(voterId, choice, ctx, gameState, bot) {
  if (!_execSession) return;

  const voter = gameState.players.get(voterId);
  if (!voter || !voter.isAlive) {
    return ctx.answerCbQuery("⚠️ Only alive players can vote.").catch(() => {});
  }
  if (voter.silencedLastRound) {
    return ctx
      .answerCbQuery("🤫 You were silenced and cannot vote today.")
      .catch(() => {});
  }
  if (voterId === _execSession.nomineeId) {
    return ctx
      .answerCbQuery("⚠️ You cannot vote in your own trial.")
      .catch(() => {});
  }

  _execSession.votes.set(voterId, choice);
  await ctx
    .answerCbQuery(
      choice === "guilty" ? "✅ Voted guilty" : "❌ Voted innocent",
    )
    .catch(() => {});

  if (_execSession.messageId) {
    await bot.telegram
      .editMessageText(
        gameState.groupChatId,
        _execSession.messageId,
        undefined,
        _execSession.buildMessageText(),
        {
          parse_mode: "HTML",
          reply_markup: _buildExecKeyboard(
            _execSession.round,
            _execSession.nomineeId,
          ),
        },
      )
      .catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYBOARD BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function _buildNomKeyboard(gameState, round) {
  const rows = gameState.playersAlive.map((id, i) => {
    const p = gameState.players.get(id);
    return [
      {
        text: `${gameState.emojiArray[i]} ${p?.username ?? "?"}`,
        callback_data: `vote_nom:${round}:${id}`,
      },
    ];
  });
  return { inline_keyboard: rows };
}

function _buildExecKeyboard(round, nomineeId) {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ Guilty",
          callback_data: `vote_exec:${round}:${nomineeId}:guilty`,
        },
        {
          text: "❌ Innocent",
          callback_data: `vote_exec:${round}:${nomineeId}:innocent`,
        },
      ],
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NOMINATION VOTE RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function runNominationVote(bot, gameState, round) {
  const groupChatId = gameState.groupChatId;
  const threshold = Math.ceil(gameState.playersAlive.length / 2.4);

  return new Promise(async (resolve) => {
    _nomSession = new NominationSession(
      round,
      gameState,
      bot,
      threshold,
      resolve,
    );

    let keyboard;
    try {
      keyboard = _buildNomKeyboard(gameState, round);
    } catch (err) {
      console.error("Failed to build nomination keyboard:", err.message);
      _nomSession = null;
      return resolve(null);
    }

    let sent;
    try {
      sent = await bot.telegram.sendMessage(
        groupChatId,
        _nomSession.buildMessageText(),
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      console.error("runNominationVote send error:", err.message);
      _nomSession = null;
      return resolve(null);
    }

    _nomSession.messageId = sent.message_id;

    _nomSession.timer = setTimeout(async () => {
      if (!_nomSession) return;

      const nominee = _nomSession.checkThreshold();

      await bot.telegram
        .editMessageReplyMarkup(groupChatId, sent.message_id, undefined, {
          inline_keyboard: [],
        })
        .catch(() => {});

      const session = _nomSession;
      _nomSession = null;
      session.end(nominee);
    }, gameState.settings.dayTime * 1000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION VOTE RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function runExecutionVote(bot, gameState, round, nomineeId) {
  const groupChatId = gameState.groupChatId;
  const nominee = gameState.players.get(nomineeId);

  if (!nominee)
    return { executed: false, nomineeId, yayVoters: [], nayVoters: [] };

  return new Promise(async (resolve) => {
    _execSession = new ExecutionSession(
      round,
      nomineeId,
      gameState,
      (result) => {
        const { yay, nay, yayVoters, nayVoters } = _execSession.tally();
        if (_execSession.messageId) {
          bot.telegram
            .editMessageReplyMarkup(
              groupChatId,
              _execSession.messageId,
              undefined,
              { inline_keyboard: [] },
            )
            .catch(() => {});
        }
        resolve({
          executed: yay > nay,
          nomineeId,
          yayVoters,
          nayVoters,
        });
      },
    );

    try {
      const sent = await bot.telegram.sendMessage(
        groupChatId,
        _execSession.buildMessageText(),
        {
          parse_mode: "HTML",
          reply_markup: _buildExecKeyboard(round, nomineeId),
        },
      );
      _execSession.messageId = sent.message_id;
    } catch (err) {
      console.error("runExecutionVote send error:", err.message);
      _execSession = null;
      return resolve({
        executed: false,
        nomineeId,
        yayVoters: [],
        nayVoters: [],
      });
    }

    _execSession.timer = setTimeout(() => {
      if (!_execSession) return;
      const session = _execSession;
      _execSession = null;
      session.end(null);
    }, gameState.settings.dayTime * 1000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION RESULT ANNOUNCER
// ─────────────────────────────────────────────────────────────────────────────

async function announceExecutionResult(bot, gameState, result) {
  const { executed, nomineeId, yayVoters, nayVoters } = result;
  const groupChatId = gameState.groupChatId;
  const nominee = gameState.players.get(nomineeId);
  if (!nominee) return;

  const mayorId = gameState.mayor;
  const mayorAlive =
    mayorId &&
    gameState.players.get(mayorId)?.isAlive &&
    gameState.roleState.Mayor.revealed;

  const formatVoters = (ids) => {
    if (!ids || ids.length === 0) return "None";
    return ids
      .map((id) => {
        const p = gameState.players.get(id);
        const mayorTag = mayorAlive && id === mayorId ? " 👑" : "";
        return p ? `${p.username}${mayorTag}` : "?";
      })
      .join(", ");
  };

  if (!executed) {
    await bot.telegram
      .sendMessage(
        groupChatId,
        `🟢 <b>${nominee.username} has been acquitted!</b>\n\n` +
          `<b>Guilty:</b> ${formatVoters(yayVoters)}\n` +
          `<b>Innocent:</b> ${formatVoters(nayVoters)}`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return;
  }

  nominee.isAlive = false;
  gameState.players.set(nomineeId, nominee);
  gameState.playersAlive = gameState.playersAlive.filter(
    (id) => id !== nomineeId,
  );

  if (nominee.align === "Mafia") {
    const { notifyGodfatherSuccession } = require("./nightResolver");
    await notifyGodfatherSuccession(bot, gameState);
  }

  await bot.telegram
    .sendMessage(
      groupChatId,
      `🔴 <b>${nominee.username} is found guilty and executed!</b>\n\n` +
        `<b>Guilty:</b> ${formatVoters(yayVoters)}\n` +
        `<b>Innocent:</b> ${formatVoters(nayVoters)}`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});

  const { revealLastWill } = require("./dayAnnouncements");
  if (nominee.lastWill && nominee.lastWill.length > 0) {
    await revealLastWill(bot, groupChatId, nominee);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JAILER DAYTIME JAIL SELECTION
// ─────────────────────────────────────────────────────────────────────────────

async function collectJailerDay(bot, userId, round, gameState) {
  const rs = gameState.roleState.Jailer;

  if (!rs.canJail) {
    rs.canJail = true;
    rs.previousSelection = rs.lastSelection;
    rs.lastSelection = null;

    await bot.telegram
      .sendMessage(
        userId,
        `⛓ <b>You jailed someone last night</b>, so you're off duty today.\n\n` +
          `You can select a new prisoner tomorrow.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return;
  }

  const targetIds = gameState.playersAlive.filter((id) => id !== userId);
  if (targetIds.length === 0) return;

  const options = targetIds.map((id, i) => ({
    label: `${gameState.emojiArray[i]} ${gameState.players.get(id).username}`,
    value: String(id),
  }));
  options.push({ label: "⏭ No prisoner tonight", value: "skip" });

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_jailer_day",
    timeout: gameState.settings.dayTime,
    gameState,
    text:
      `⛓ <b>Day ${round} — Choose your prisoner for tonight</b>\n\n` +
      `Select a player to jail. They won't be able to act tonight, ` +
      `but will be protected from attacks.\n\n` +
      `You can also execute them during the night — but killing a ` +
      `villager will permanently remove your execute ability.`,
    options,
  });

  rs.previousSelection = rs.lastSelection;

  if (!selection) {
    rs.canJail = true;
    rs.lastSelection = null;
    await bot.telegram
      .sendMessage(userId, "🔓 You chose not to jail anyone tonight.", {
        parse_mode: "HTML",
      })
      .catch(() => {});
    return;
  }

  const targetId = Number(selection);
  const target = gameState.players.get(targetId);
  rs.canJail = false;
  rs.lastSelection = targetId;

  await bot.telegram
    .sendMessage(
      userId,
      `⛓ <b>${target?.username ?? "?"} will be jailed tonight.</b>\n\n` +
        `You can choose whether to execute them during the night phase.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function clearActiveSessions() {
  if (_nomSession) {
    _nomSession.end(null);
    _nomSession = null;
  }
  if (_execSession) {
    _execSession.end(null);
    _execSession = null;
  }
}

module.exports = {
  receiveNominationVote,
  receiveExecutionVote,
  runNominationVote,
  runExecutionVote,
  announceExecutionResult,
  collectJailerDay,
  clearActiveSessions,
};
