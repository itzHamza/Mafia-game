/**
 * roles/dayVoting.js
 *
 * Day-phase voting: nomination vote, execution vote, and Jailer's
 * daytime jail-selection prompt.
 *
 * Discord equivalent:
 *   daytimeVoting() in commands/start.js:
 *     prompt.awaitReactions(filter, { time: dayTime })   → runNominationVote()
 *     votingPrompt.awaitReactions(filter, { time: ... }) → runExecutionVote()
 *   Jailer.prompt(member) during dayTime()               → collectJailerDay()
 *
 * Core architecture change:
 *   Discord had a single group message with emoji reactions; awaitReactions
 *   resolved when the timer expired, then counted reactions.
 *
 *   Telegram replacement:
 *     1. A single group message with an inline keyboard (one button per alive player).
 *     2. Module-level NominationSession / ExecutionSession track live vote state.
 *     3. bot.js action handlers call receiveNominationVote() / receiveExecutionVote()
 *        when a button is pressed — routing into the active session.
 *     4. The session resolves its Promise either on timer expiry or when
 *        the nomination threshold is met early.
 *     5. After each vote, the group message is edited to show live tallies —
 *        replacing the visual feedback of growing emoji reaction counts.
 */

"use strict";

const { sendSelectionPrompt } = require("./nightPrompts");
const actionRegistry = require("./actionRegistry");

// ─────────────────────────────────────────────────────────────────────────────
// SESSION CLASSES
// Discord equivalent: the closure around prompt.awaitReactions()
// Each session wraps a Promise and holds the live vote state.
// ─────────────────────────────────────────────────────────────────────────────

class NominationSession {
  /**
   * @param {number}   round
   * @param {Object}   gameState
   * @param {Object}   bot
   * @param {number}   threshold   Votes required to nominate (ceil(alive/2.4))
   * @param {Function} resolve     Called with nomineeId (number) or null.
   */
  constructor(round, gameState, bot, threshold, resolve) {
    this.round = round;
    this.gameState = gameState;
    this.bot = bot;
    this.threshold = threshold;
    this.resolve = resolve;
    this.timer = null;
    this.messageId = null;

    // Maps voterId (number) → targetId (number)
    // Voters can change their vote by pressing a different button.
    // Discord equivalent: awaitReactions collected ALL reactions per emoji;
    // we track one vote per voter instead.
    this.votes = new Map();
  }

  /**
   * Tally votes, accounting for the Mayor's double vote.
   * Discord equivalent:
   *   var count = emojiData.count;
   *   if (Array.from(emojiData.users.cache.values()).map(t => t.id).includes(gamedata.game.game.mayor)
   *       && gamedata.players.get(userids.get(mayor)).isAlive) count++;
   *
   * @returns {Map<number, number>}  targetId → weighted vote count
   */
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

  /**
   * Check whether any candidate has met the nomination threshold.
   * Discord equivalent:
   *   if (currentReaction.length !== 1 || (maxCount - 1) <= alive.length / 2.4) → inconclusive
   *   Note: original's (maxCount - 1) subtracts the bot's own reaction.
   *         We don't add a bot reaction so no subtraction needed.
   *
   * @returns {number|null}  Nominee's userId if threshold met, or null.
   */
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

  /**
   * Build the current vote tally text for the message body.
   * Discord equivalent: N/A — Discord showed reaction counts visually.
   * Here we update the message text on every vote to show live standings.
   */
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
    this.resolve = null; // prevent double-resolve
    if (fn) fn(result);
  }
}

class ExecutionSession {
  /**
   * @param {number}   round
   * @param {number}   nomineeId
   * @param {Object}   gameState
   * @param {Function} resolve   Called with true (execute) or false (acquit).
   */
  constructor(round, nomineeId, gameState, resolve) {
    this.round = round;
    this.nomineeId = nomineeId;
    this.gameState = gameState;
    this.resolve = resolve;
    this.timer = null;
    this.messageId = null;

    // Maps voterId → "guilty" | "innocent"
    this.votes = new Map();
  }

  /**
   * Count weighted yay/nay votes.
   * Discord equivalent:
   *   let yayCount = yays.length; let nayCount = nays.length;
   *   if (Mayor.revealed && mayor.isAlive) { if (yays.includes(mayor)) yayCount++; ... }
   *
   * @returns {{ yay: number, nay: number, yayVoters: number[], nayVoters: number[] }}
   */
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
    return (
      `⚖️ <b>${nominee?.username ?? "?"} has been nominated!</b>\n\n` +
      `<@${this.nomineeId}> has ${this.gameState.settings.votingTime}s to make their case.\n\n` +
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
// One nomination and one execution session can be active at any time.
// bot.js action handlers call receiveNominationVote() / receiveExecutionVote()
// which route into whichever session is currently active.
// Discord equivalent: the closures around prompt.awaitReactions() —
// only one such closure was active at a time per game.
// ─────────────────────────────────────────────────────────────────────────────

let _nomSession = null;
let _execSession = null;

// ─────────────────────────────────────────────────────────────────────────────
// VOTE RECEIVERS — called from bot.js action handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process an incoming nomination vote button press.
 * Discord equivalent: the promptFilter reaction filter in daytimeVoting().
 *
 * Guards replicated from original:
 *   tuser.id !== botId                      → ctx.from.is_bot (handled in bot.js)
 *   gamedata.userids.get(tuser.id)          → gameState.players.has(voterId)
 *   players.get(id).isAlive                 → player.isAlive
 *   !players.get(id).silencedThisRound      → !player.silencedLastRound (bug-fix: see Phase 5 notes)
 *
 * @param {number}  voterId
 * @param {number}  targetId
 * @param {Object}  ctx        Telegraf context (for answerCbQuery and edit)
 * @param {Object}  gameState
 * @param {Object}  bot
 */
async function receiveNominationVote(voterId, targetId, ctx, gameState, bot) {
  if (!_nomSession) return;

  // ── Eligibility guards ────────────────────────────────────────────────────
  const voter = gameState.players.get(voterId);
  if (!voter || !voter.isAlive) {
    return ctx.answerCbQuery("⚠️ Only alive players can vote.").catch(() => {});
  }
  // Discord equivalent: !silencedThisRound
  // We use silencedLastRound (correct flag for day phase — see Phase 5 notes)
  if (voter.silencedLastRound) {
    return ctx
      .answerCbQuery("🤫 You were silenced and cannot vote today.")
      .catch(() => {});
  }
  if (!gameState.playersAlive.includes(targetId)) {
    return ctx.answerCbQuery("⚠️ That player is not eligible.").catch(() => {});
  }

  // ── Record/change vote ────────────────────────────────────────────────────
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

  // ── Edit message to show live tally ──────────────────────────────────────
  // Discord equivalent: N/A — Discord updated reaction counts automatically.
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

  // ── Early resolution if threshold met ────────────────────────────────────
  const nominee = _nomSession.checkThreshold();
  if (nominee !== null) {
    _nomSession.end(nominee);
    _nomSession = null;
  }
}

/**
 * Process an incoming execution vote button press.
 * Discord equivalent: the promptFilter in the execution awaitReactions() block.
 *
 * Guards from original:
 *   tuser.id !== botId                       → ctx.from.is_bot
 *   players.get(id).isAlive                  → player.isAlive
 *   !silencedThisRound                       → !silencedLastRound
 *   tuser.id !== gamedata.players.get(nominee).id  → voterId !== nomineeId
 *
 * @param {number}  voterId
 * @param {string}  choice    "guilty" | "innocent"
 * @param {Object}  ctx
 * @param {Object}  gameState
 * @param {Object}  bot
 */
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
  // Nominee cannot vote in their own trial
  // Discord equivalent: tuser.id !== gamedata.players.get(nominee).id
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

  // Update live tally
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
// Discord equivalent: prompt.react(emoji) for each option
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the nomination inline keyboard.
 * One button per alive player; callback data: "vote_nom:<round>:<voterId>:<targetId>"
 * We use a single shared keyboard — each voter's button press identifies them
 * via their Telegram user ID (ctx.from.id) in the action handler, NOT from
 * the callback data. The callback data only carries the TARGET.
 *
 * Discord equivalent: Each emoji reaction on a shared group message.
 */
function _buildNomKeyboard(gameState, round) {
  const rows = gameState.playersAlive.map((id, i) => {
    const p = gameState.players.get(id);
    return [
      {
        text: `${gameState.emojiArray[i]} ${p?.username ?? "?"}`,
        // callback_data: "vote_nom:<round>:<targetId>"
        // Note: voterId is taken from ctx.from.id in the action handler
        callback_data: `vote_nom:${round}:${id}`,
      },
    ];
  });
  return { inline_keyboard: rows };
}

/**
 * Build the execution inline keyboard.
 * callback_data: "vote_exec:<round>:<nomineeId>:<choice>"
 */
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
// Discord equivalent: the first awaitReactions() block in daytimeVoting()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the nomination vote and return the nominee's userId, or null if inconclusive.
 *
 * Discord equivalent:
 *   channel.send(nominateMsg) → prompt.awaitReactions(filter, { time: dayTime * 1000 })
 *   → emoji.filter(t => t.count > 1) → find max, check uniqueness + threshold
 *
 * @param {Object} bot
 * @param {Object} gameState
 * @param {number} round
 * @returns {Promise<number|null>}  Nominee's userId, or null if inconclusive.
 */
async function runNominationVote(bot, gameState, round) {
  const groupChatId = gameState.groupChatId;

  // Nomination threshold: ceil(alive / 2.4)
  // Discord equivalent: Math.ceil(gamedata.game.game.playersAlive.length / 2.4)
  const threshold = Math.ceil(gameState.playersAlive.length / 2.4);

  return new Promise(async (resolve) => {
    _nomSession = new NominationSession(
      round,
      gameState,
      bot,
      threshold,
      resolve,
    );

    // Send the nomination message to the group
    const keyboard = _buildNomKeyboard(gameState, round);
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

    // Timer — resolves with final tally winner on expiry
    // Discord equivalent: awaitReactions({ time: dayTime * 1000 })
    _nomSession.timer = setTimeout(async () => {
      if (!_nomSession) return; // already resolved by threshold

      const nominee = _nomSession.checkThreshold();

      // Disable keyboard
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
// Discord equivalent: the second awaitReactions() block in daytimeVoting()
// (fires after a player is successfully nominated)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the execution (guilty/innocent) vote for a nominated player.
 *
 * Discord equivalent:
 *   votingPrompt.react("✅"); votingPrompt.react("❌")
 *   → votingPrompt.awaitReactions(filter, { time: dayTime * 1000 })
 *   → count yays/nays with Mayor weight → execute if yay > nay
 *
 * @param {Object} bot
 * @param {Object} gameState
 * @param {number} round
 * @param {number} nomineeId
 * @returns {Promise<{ executed: boolean, nomineeId: number,
 *                     yayVoters: number[], nayVoters: number[] }>}
 */
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
        // Disable keyboard on end
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

    // Send to group
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

    // Discord equivalent: awaitReactions({ time: dayTime * 1000 }) on the voting prompt
    _execSession.timer = setTimeout(() => {
      if (!_execSession) return;
      const session = _execSession;
      _execSession = null;
      session.end(null); // triggers tally in the constructor's resolve wrapper
    }, gameState.settings.dayTime * 1000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION RESULT ANNOUNCER
// Discord equivalent: the votingResultMsg embed after awaitReactions resolves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Announce the execution vote result to the group and apply state changes.
 *
 * @param {Object} bot
 * @param {Object} gameState
 * @param {{ executed, nomineeId, yayVoters, nayVoters }} result
 */
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

  // Format voter lists
  // Discord equivalent: yays = yays.map(t => `<@${t}>${mayor===t ? " (Mayor)" : ""}`)
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
    // Acquitted
    // Discord equivalent: "was acquitted" votingResultMsg
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

  // Executed — update game state
  // Discord equivalent: user.isAlive = false; playersAlive.filter(...); channel.updateOverwrite(...)
  nominee.isAlive = false;
  gameState.players.set(nomineeId, nominee);
  gameState.playersAlive = gameState.playersAlive.filter(
    (id) => id !== nomineeId,
  );

  // Notify Godfather succession if a Mafia member was executed
  // Discord equivalent: if (user.align === "Mafia" && mafiaRoles[role].isGodfather) updateGodfather()
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

  // Reveal last will on execution
  // Discord equivalent: if (votingResult && player.will.length !== 0) channel.send(will)
  const { revealLastWill } = require("./dayAnnouncements");
  if (nominee.lastWill && nominee.lastWill.length > 0) {
    await revealLastWill(bot, groupChatId, nominee);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JAILER DAYTIME JAIL SELECTION
// Discord equivalent: gamedata.villageRoles["Jailer"].prompt(member)
// called during dayTime() before voting begins.
//
// The Jailer selects who to imprison for the COMING night during the day phase.
// This uses dayTime seconds as the timeout (not nightTime).
// The prompt fires concurrently — it does not block the voting.
//
// Discord equivalent: the call was fire-and-forget:
//   if (temp.role === "Jailer") { gamedata.villageRoles["Jailer"].prompt(member); }
//   (no await — voting proceeded while Jailer was deciding)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the Jailer their daytime jail-selection prompt (non-blocking).
 * Call this with `collectJailerDay(...).catch(console.error)` to fire-and-forget.
 *
 * @param {Object} bot
 * @param {number} userId     The Jailer's Telegram user ID.
 * @param {number} round
 * @param {Object} gameState
 * @returns {Promise<void>}
 */
async function collectJailerDay(bot, userId, round, gameState) {
  const rs = gameState.roleState.Jailer;

  // Alternating-night restriction
  // Discord equivalent: if (that.canJail) { ... } else { that.canJail = true; ... }
  if (!rs.canJail) {
    // Skipped this time — reset for next day
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

  // Eligible targets: all alive players except self
  const targetIds = gameState.playersAlive.filter((id) => id !== userId);

  if (targetIds.length === 0) return;

  const options = targetIds.map((id, i) => ({
    label: `${gameState.emojiArray[i]} ${gameState.players.get(id).username}`,
    value: String(id),
  }));
  options.push({ label: "⏭ No prisoner tonight", value: "skip" });

  // Uses the sendSelectionPrompt infrastructure from nightPrompts.js
  // with prefix "na_jailer_day" (caught by /^na/ handler in bot.js)
  // and dayTime as the timeout (not nightTime)
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

/** Forcibly end any active voting sessions (called on game reset). */
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
