/**
 * roles/nightPrompts.js
 *
 * Night-phase DM prompt senders for every role.
 *
 * Discord equivalent: each role's prompt(user) and night(user) methods
 * in GameData's mafiaRoles / villageRoles / neutralRoles objects.
 *
 * Core replacement:
 *   Discord: user.send(embed) → prompt.awaitReactions(filter, { time })
 *              → emoji.first().emoji.name → resolve(selection)
 *   Telegram: bot.telegram.sendMessage(userId, text, { reply_markup: keyboard })
 *              → user presses button → bot.action() → actionRegistry.resolve(key, value)
 *              → Promise resolves with the selection
 *
 * Each exported collect*() function:
 *   - Sends an inline keyboard DM to the player
 *   - Returns a Promise<{ action, choice }|{}> (same shape as Discord's night() return)
 *   - Resolves immediately with {} if role has no action this night
 *   - Resolves with null-equivalent {} on timeout (no action taken)
 */

"use strict";

const actionRegistry = require("./actionRegistry");

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC PROMPT HELPER
// Discord equivalent: user.send(embed with reactions) → prompt.awaitReactions(...)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an inline keyboard DM and return a Promise that resolves with the
 * player's selection string, or null if they skip / time out.
 *
 * @param {Object} opts
 * @param {Object}   opts.bot
 * @param {number}   opts.userId     Telegram user ID of the acting player.
 * @param {string}   opts.text       HTML message body.
 * @param {Array}    opts.options    [{ label: string, value: string }]
 * @param {string}   opts.prefix     Registry key prefix (e.g. 'na', 'na_pi1').
 * @param {number}   opts.round      Current game round number.
 * @param {number}   opts.timeout    Seconds before auto-resolving with null.
 * @param {Object}   opts.gameState
 * @returns {Promise<string|null>}  The selected value string, or null.
 */
async function sendSelectionPrompt({
  bot,
  userId,
  text,
  options,
  prefix,
  round,
  timeout,
  gameState,
}) {
  const key = `${prefix}:${round}:${userId}`;

  // Build Telegram inline keyboard — one button per row for readability.
  // Discord equivalent: prompt.react(emoji) for each option.
    let inline_keyboard;
    try {
      inline_keyboard = options.map((opt) => [
        {
          text: opt.label,
          callback_data: `${key}:${opt.value}`,
        },
      ]);
    } catch (err) {
      console.error("Failed to build night prompt keyboard:", err.message);
      return null;
    }

    return new Promise(async (resolve) => {
      let timer;
      let sentMsgId = null;

      // Register resolver BEFORE sending so there's no race condition
      // between the message arriving and a fast button press.
      actionRegistry.register(key, (value) => {
        clearTimeout(timer);
        resolve(value === "skip" ? null : value);
      });

      // Send the prompt DM
      // Discord equivalent: user.send(embed) → saves the returned message as `prompt`
      try {
        const sent = await bot.telegram.sendMessage(userId, text, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard },
        });
        sentMsgId = sent.message_id;
        // Track so we can disable the keyboard on timeout
        gameState.activeNightPrompts.set(userId, sentMsgId);
      } catch {
        // Most common cause: user never started a private chat with the bot.
        // This should have been caught in /setup, but handle it gracefully.
        actionRegistry.deregister(key);
        return resolve(null);
      }

      // Night timer — mirrors Discord's awaitReactions { time: nightTime * 1000 }
      timer = setTimeout(async () => {
        if (!actionRegistry.has(key)) return; // already resolved by button press
        actionRegistry.deregister(key);

        // Disable the keyboard so stale buttons can't fire next round.
        // Discord equivalent: N/A — Discord message reactions became inert automatically.
        if (sentMsgId) {
          await bot.telegram
            .editMessageReplyMarkup(userId, sentMsgId, undefined, {
              inline_keyboard: [],
            })
            .catch(() => {});
        }

        await bot.telegram
          .sendMessage(userId, "⏰ Time's up! No action taken this night.")
          .catch(() => {});

        resolve(null);
      }, timeout * 1000);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the standard options array for a single-player selection prompt.
 * Includes a Skip button at the end.
 *
 * @param {number[]} targetIds   Filtered list of eligible target user IDs.
 * @param {Object}   gameState
 * @returns {Array<{label: string, value: string}>}
 */
function buildPlayerOptions(targetIds, gameState) {
  const opts = targetIds.map((id, i) => ({
    label: `${gameState.emojiArray[i]} ${gameState.players.get(id).username}`,
    value: String(id),
  }));
  opts.push({ label: "⏭ No action tonight", value: "skip" });
  return opts;
}

/**
 * Check if a selection targets the Baiter and return the baited action if so.
 * Discord equivalent: the inline ternary in each role's night() resolver:
 *   resolve(players.get(selection).role === "Baiter"
 *     ? { action: "baited", choice: userids.get(user.id) }
 *     : { action: <role_action>, choice: selection })
 *
 * @param {number} targetId   The chosen target's user ID.
 * @param {number} actorId    The acting player's user ID.
 * @param {Object} gameState
 * @returns {{ action: 'baited', choice: number }|null}  null if target is not Baiter.
 */
function checkBaiter(targetId, actorId, gameState) {
  const target = gameState.players.get(targetId);
  if (target && target.role === "Baiter") {
    return { action: "baited", choice: actorId };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAFIA ROLE COLLECTORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Godfather / acting-Godfather kill prompt.
 * Discord equivalent: mafiaRoles["Godfather"].prompt(user) + night(user)
 * Target pool: alive non-Mafia players only.
 */
async function collectKill(bot, userId, round, gameState) {
  const targetIds = gameState.playersAlive.filter((id) => {
    const p = gameState.players.get(id);
    return id !== userId && p && p.align !== "Mafia";
  });

  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🔴 <b>Night ${round} — Choose your kill target</b>\n\n` +
      `Select a player to eliminate tonight:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to kill anyone tonight.", {
        parse_mode: "HTML",
      })
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `🔪 You chose to kill <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "kill", choice: targetId };
}

/**
 * Framer prompt.
 * Discord equivalent: mafiaRoles["Framer"].prompt(user) + night(user)
 * Target pool: alive non-Mafia players. Makes Detective see target as Mafia.
 */
async function collectFrame(bot, userId, round, gameState) {
  const targetIds = gameState.playersAlive.filter((id) => {
    const p = gameState.players.get(id);
    return id !== userId && p && p.align !== "Mafia";
  });

  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🔴 <b>Night ${round} — Choose your frame target</b>\n\n` +
      `Select a player to frame (they will appear as Mafia to the Detective):`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to frame anyone tonight.")
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `🖼 You chose to frame <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "frame", choice: targetId };
}

/**
 * Silencer prompt.
 * Discord equivalent: mafiaRoles["Silencer"].prompt(user) + night(user)
 *
 * Two restrictions ported exactly from original:
 *   1. Can only silence every OTHER night (workedLastNight flag)
 *   2. Cannot silence the same person twice in the entire game (silencedSoFar list)
 */
async function collectSilence(bot, userId, round, gameState) {
  const rs = gameState.roleState.Silencer;

  // Alternating-night restriction
  // Discord equivalent: if (that.workedLastNight) { resolve(""); return; }
  if (rs.workedLastNight) {
    rs.workedLastNight = false;
    await bot.telegram
      .sendMessage(
        userId,
        "😴 You're too tired to silence anyone tonight — get some rest.",
      )
      .catch(() => {});
    return {};
  }

  // Filter out already-silenced players and self
  // Discord equivalent: playersAlive.filter(t => t !== self && !silencedSoFar.includes(t))
  const targetIds = gameState.playersAlive.filter(
    (id) => id !== userId && !rs.silencedSoFar.includes(id),
  );

  if (targetIds.length === 0) {
    await bot.telegram
      .sendMessage(userId, "No eligible targets to silence tonight.")
      .catch(() => {});
    return {};
  }

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🔴 <b>Night ${round} — Choose your silence target</b>\n\n` +
      `Select a player to silence (they cannot speak at tomorrow's meeting):`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to silence anyone tonight.")
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  rs.workedLastNight = true;
  rs.silencedSoFar.push(targetId);

  await bot.telegram
    .sendMessage(
      userId,
      `🤫 You chose to silence <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "silence", choice: targetId };
}

// ─────────────────────────────────────────────────────────────────────────────
// VILLAGE ROLE COLLECTORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Doctor heal prompt.
 * Discord equivalent: villageRoles["Doctor"].prompt(user) + night(user)
 * Restriction: cannot heal the same person two nights in a row (lastChoice).
 * Note: Doctor CAN heal themselves (no self-exclusion).
 */
async function collectHeal(bot, userId, round, gameState) {
  const rs = gameState.roleState.Doctor;

  // Exclude last night's choice — Discord equivalent: filter(t => t !== that.lastChoice)
  const targetIds = gameState.playersAlive.filter((id) => id !== rs.lastChoice);

  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🟢 <b>Night ${round} — Choose who to protect</b>\n\n` +
      `Select a player to save from a Mafia attack tonight:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to save anyone tonight.")
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  rs.lastChoice = targetId; // Set in prompt layer — Discord equivalent

  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `💊 You chose to protect <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "heal", choice: targetId };
}

/**
 * Detective investigate prompt.
 * Discord equivalent: villageRoles["Detective"].prompt(user) + night(user)
 * Target pool: any alive player except self.
 */
async function collectCheck(bot, userId, round, gameState) {
  const targetIds = gameState.playersAlive.filter((id) => id !== userId);

  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🟢 <b>Night ${round} — Choose who to investigate</b>\n\n` +
      `Select a player to determine if they are in the Mafia:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to investigate anyone tonight.")
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `🔍 You chose to investigate <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "check", choice: targetId };
}

/**
 * Vigilante shoot prompt.
 * Discord equivalent: villageRoles["Vigilante"].prompt(user) + night(user)
 * Warning: killing a villager causes the Vigilante to die of guilt.
 */
async function collectShoot(bot, userId, round, gameState) {
  const targetIds = gameState.playersAlive.filter((id) => id !== userId);

  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🟢 <b>Night ${round} — Choose who to shoot</b>\n\n` +
      `⚠️ <i>Warning: shooting a villager will cause you to die of guilt!</i>\n\n` +
      `Select a player to shoot:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to shoot anyone tonight.")
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `🔫 You chose to shoot <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "kill-vigil", choice: targetId };
}

/**
 * Mayor reveal prompt.
 * Discord equivalent: villageRoles["Mayor"].prompt(user) + night(user)
 * Y/N choice: reveal self as Mayor tomorrow, gaining an extra vote.
 * Uses na_mayor: prefix to distinguish from standard target selection.
 */
async function collectReveal(bot, userId, round, gameState) {
  const rs = gameState.roleState.Mayor;

  // Already revealed — no action needed
  if (rs.revealed) return {};

  // If silenced last round, the reveal is reset (Discord equivalent)
  const player = gameState.players.get(userId);
  if (player && player.silencedLastRound) rs.revealed = false;

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_mayor",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🟢 <b>Night ${round} — Mayor Decision</b>\n\n` +
      `Do you want to reveal yourself as the Mayor at tomorrow's meeting?\n\n` +
      `<i>Revealing grants you an extra vote but makes you a target.</i>`,
    options: [
      { label: "✅ Yes — reveal myself tomorrow", value: "yes" },
      { label: "❌ No — stay hidden", value: "no" },
    ],
  });

  if (!selection || selection === "no") {
    await bot.telegram
      .sendMessage(userId, "🏛 You chose to remain hidden tomorrow.")
      .catch(() => {});
    return {};
  }

  // selection === "yes"
  rs.revealed = true;
  gameState.mayor = userId;

  await bot.telegram
    .sendMessage(
      userId,
      "🏛 You will reveal yourself as the <b>Mayor</b> at tomorrow's meeting!",
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "mayor-reveal" };
}

/**
 * Distractor prompt.
 * Discord equivalent: villageRoles["Distractor"].prompt(user) + night(user)
 * Alternating night restriction (same as Silencer's workedLastNight).
 */
async function collectDistract(bot, userId, round, gameState) {
  const rs = gameState.roleState.Distractor;

  // Alternating-night restriction
  if (rs.workedLastNight) {
    rs.workedLastNight = false;
    await bot.telegram
      .sendMessage(
        userId,
        "😴 You're too tired to distract anyone tonight — get some rest.",
      )
      .catch(() => {});
    return {};
  }

  const targetIds = gameState.playersAlive.filter((id) => id !== userId);

  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🟢 <b>Night ${round} — Choose who to distract</b>\n\n` +
      `Select a player to distract (their action will fail tonight):`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to distract anyone tonight.")
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  rs.workedLastNight = true;

  await bot.telegram
    .sendMessage(
      userId,
      `🥴 You chose to distract <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "distract", choice: targetId };
}

/**
 * PI double-investigation prompt.
 * Discord equivalent: villageRoles["PI"].prompt(user) + night(user)
 *
 * Two selections required. Ported as two sequential Promises:
 *   Step 1: uses na_pi1: prefix → resolves with first target ID
 *   Step 2: uses na: prefix     → resolves with second target ID
 *           (first target is excluded from second prompt's options)
 *
 * Discord equivalent: awaitReactions collected up to 2 emoji reactions.
 * The order was determined by emoji.first(2), which could be unreliable.
 * Sequential prompts are cleaner and intentional.
 */
async function collectPI(bot, userId, round, gameState) {
  const eligible = gameState.playersAlive.filter((id) => id !== userId);

  if (eligible.length < 2) {
    await bot.telegram
      .sendMessage(userId, "⚠️ Not enough players alive to compare.")
      .catch(() => {});
    return {};
  }

  // ── Step 1: First target ─────────────────────────────────────────────────
  const sel1 = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_pi1",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🟢 <b>Night ${round} — PI Investigation (1/2)</b>\n\n` +
      `Select the <b>first</b> player to compare:`,
    options: buildPlayerOptions(eligible, gameState),
  });

  if (!sel1) {
    await bot.telegram
      .sendMessage(userId, "You chose not to investigate anyone tonight.")
      .catch(() => {});
    return {};
  }

  const target1Id = Number(sel1);
  const baited1 = checkBaiter(target1Id, userId, gameState);
  if (baited1) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited1;
  }

  // ── Step 2: Second target (excluding first) ───────────────────────────────
  const eligible2 = eligible.filter((id) => id !== target1Id);

  if (eligible2.length === 0) {
    await bot.telegram
      .sendMessage(userId, "⚠️ No remaining players to compare against.")
      .catch(() => {});
    return {};
  }

  const target1Name = gameState.players.get(target1Id).username;
  const sel2 = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: Math.ceil(gameState.settings.nightTime / 2), // Shorter window for step 2
    gameState,
    text:
      `🟢 <b>Night ${round} — PI Investigation (2/2)</b>\n\n` +
      `Comparing against: <b>${target1Name}</b>\n\n` +
      `Select the <b>second</b> player:`,
    options: buildPlayerOptions(eligible2, gameState),
  });

  if (!sel2) {
    await bot.telegram
      .sendMessage(
        userId,
        "Investigation incomplete — no second target selected.",
      )
      .catch(() => {});
    return {};
  }

  const target2Id = Number(sel2);
  const baited2 = checkBaiter(target2Id, userId, gameState);
  if (baited2) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited2;
  }

  const target2Name = gameState.players.get(target2Id).username;
  await bot.telegram
    .sendMessage(
      userId,
      `🔍 You chose to compare <b>${target1Name}</b> and <b>${target2Name}</b>.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "pi-check", choice: [target1Id, target2Id] };
}

/**
 * Spy watch prompt.
 * Discord equivalent: villageRoles["Spy"].prompt(user) + night(user)
 * Finds out who the watched player visited (if anyone).
 */
async function collectSpy(bot, userId, round, gameState) {
  const targetIds = gameState.playersAlive.filter((id) => id !== userId);

  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🟢 <b>Night ${round} — Choose who to watch</b>\n\n` +
      `Select a player to follow and discover who they visited:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to watch anyone tonight.")
      .catch(() => {});
    return {};
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `👁 You chose to watch <b>${target.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "spy-check", choice: targetId };
}

/**
 * Jailer execute prompt (night phase only).
 * Discord equivalent: villageRoles["Jailer"].night(user)
 *
 * Note: The daytime jail SELECTION prompt (who to imprison) is part of the
 * day cycle and will be ported in Phase 5. This function only handles the
 * nightly Y/N decision to execute the already-selected prisoner.
 *
 * Uses na_jailer: prefix to distinguish from standard target selection.
 */
async function collectJailerKill(bot, userId, round, gameState) {
  const rs = gameState.roleState.Jailer;

  // No prisoner, or lost execute ability by killing a villager
  // Discord equivalent: if (that.killsLeft !== 0 && that.lastSelection)
  if (rs.killsLeft === 0 || !rs.lastSelection) return {};

  const prisoner = gameState.players.get(rs.lastSelection);
  if (!prisoner) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_jailer",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `⛓ <b>Night ${round} — Execute your prisoner?</b>\n\n` +
      `Your prisoner is: <b>${prisoner.username}</b>\n\n` +
      `Do you want to execute them tonight?`,
    options: [
      { label: `⚖️ Yes — execute ${prisoner.username}`, value: "yes" },
      { label: "🔓 No — release them", value: "no" },
    ],
  });

  if (!selection || selection === "no") {
    await bot.telegram
      .sendMessage(
        userId,
        `🔓 You chose not to execute <b>${prisoner.username}</b>.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }

  await bot.telegram
    .sendMessage(
      userId,
      `⚖️ You chose to execute <b>${prisoner.username}</b> tonight.`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "execute", choice: rs.lastSelection };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEUTRAL ROLE COLLECTORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arsonist douse/ignite prompt.
 * Discord equivalent: neutralRoles["Arsonist"].prompt(user) + night(user)
 *
 * Two action types:
 *   - Douse: add a player to the doused list for a future ignite
 *   - Ignite: kill ALL currently doused players simultaneously
 *
 * In the original, ignite was represented by the player selecting themselves.
 * Here we use an explicit "IGNITE" button for clarity.
 *
 * Note: the doused list is updated here (prompt layer), matching the original
 * where that.doused.push(selection) happened inside prompt().
 */
async function collectArsonist(bot, userId, round, gameState) {
  const rs = gameState.roleState.Arsonist;
  const doused = rs.doused;

  // Eligible to douse: alive players not yet doused, not self
  const dousable = gameState.playersAlive.filter(
    (id) => id !== userId && !doused.includes(id),
  );

  const dousedNames =
    doused.length > 0
      ? doused
          .map((id) => gameState.players.get(id)?.username ?? "?")
          .join(", ")
      : "none";

  const options = [
    {
      label: `🔥 IGNITE all doused players (${doused.length})`,
      value: "ignite",
    },
    ...dousable.map((id, i) => ({
      label: `${gameState.emojiArray[i + 1]} Douse ${gameState.players.get(id).username}`,
      value: String(id),
    })),
    { label: "⏭ No action tonight", value: "skip" },
  ];

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text:
      `🔵 <b>Night ${round} — Arsonist Action</b>\n\n` +
      `Currently doused: <b>${dousedNames}</b>\n\n` +
      `Choose your action:`,
    options,
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to act tonight.")
      .catch(() => {});
    return {};
  }

  if (selection === "ignite") {
    if (doused.length === 0) {
      await bot.telegram
        .sendMessage(userId, "⚠️ No doused players to ignite!")
        .catch(() => {});
      return {};
    }
    await bot.telegram
      .sendMessage(
        userId,
        `🔥 You ignite all ${doused.length} doused player(s) tonight!`,
      )
      .catch(() => {});
    return { action: "ignite", choice: userId };
  }

  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 You visited the Baiter's house — and were blown up!",
      )
      .catch(() => {});
    return baited;
  }

  // Record douse in prompt layer — matching the original's that.doused.push(selection)
  rs.doused.push(targetId);
  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(userId, `💧 You doused <b>${target.username}</b> tonight.`, {
      parse_mode: "HTML",
    })
    .catch(() => {});
  return { action: "douse", choice: targetId };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DISPATCHER
// Discord equivalent: the night(user) method on each role object,
// called in the nightActions() for loop in start.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch to the correct role collector for the given player.
 *
 * Godfather succession: if the original Godfather is dead, the hierarchy
 * (Mafioso → Framer → Silencer) takes over. We use getActiveGodfather()
 * instead of individual isGodfather flags (Discord's approach).
 *
 * Discord equivalent:
 *   gamedata[`${player.align.toLowerCase()}Roles`][player.role].night(user)
 *
 * @param {Object} bot
 * @param {number} userId
 * @param {number} round
 * @param {Object} gameState
 * @returns {Promise<{action: string, choice: any}|{}>}
 */
async function collectNightAction(bot, userId, round, gameState) {
  const player = gameState.players.get(userId);
  if (!player || !player.isAlive) return {};

  const role = player.role;

  // ── Godfather succession ─────────────────────────────────────────────────
  // Discord equivalent: each Mafia role checked isGodfather flag individually.
  // mafiaRoles["Mafioso"].isGodfather was set by updateGodfather() on death.
  // Here we check centrally: if this player is the active GF, they get kill prompt.
  const activeGodfatherId = gameState.getActiveGodfather();
  if (activeGodfatherId === userId && role !== "Godfather") {
    // This non-Godfather Mafia player has been promoted — use kill prompt
    await bot.telegram
      .sendMessage(
        userId,
        `🔴 <b>As the acting Godfather, you must order tonight's kill.</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return collectKill(bot, userId, round, gameState);
  }

  switch (role) {
    // ── Mafia ──────────────────────────────────────────────────────────────
    case "Godfather":
      // Original Godfather (if alive)
      return collectKill(bot, userId, round, gameState);
    case "Mafioso":
      // No action when not acting as GF
      // Discord equivalent: if (!that.isGodfather) resolve({})
      return {};
    case "Framer":
      return collectFrame(bot, userId, round, gameState);
    case "Silencer":
      return collectSilence(bot, userId, round, gameState);

    // ── Village ────────────────────────────────────────────────────────────
    case "Doctor":
      return collectHeal(bot, userId, round, gameState);
    case "Detective":
      return collectCheck(bot, userId, round, gameState);
    case "Vigilante":
      return collectShoot(bot, userId, round, gameState);
    case "Mayor":
      return collectReveal(bot, userId, round, gameState);
    case "Jailer":
      return collectJailerKill(bot, userId, round, gameState);
    case "Distractor":
      return collectDistract(bot, userId, round, gameState);
    case "PI":
      return collectPI(bot, userId, round, gameState);
    case "Spy":
      return collectSpy(bot, userId, round, gameState);

    // ── Neutral ────────────────────────────────────────────────────────────
    case "Arsonist":
      return collectArsonist(bot, userId, round, gameState);
    case "Executioner":
    case "Jester":
    case "Baiter":
      // No nightly action — Discord equivalent: night(user) { resolve({}); }
      return {};

    default:
      return {};
  }
}

module.exports = { collectNightAction, sendSelectionPrompt };
