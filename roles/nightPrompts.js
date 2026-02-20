/**
 * roles/nightPrompts.js — DEBUG BUILD
 *
 * Key log tags to watch:
 *   [PROMPT] SEND  — about to call bot.telegram.sendMessage (the DM with buttons)
 *   [PROMPT] SENT  — sendMessage returned successfully — look at the ms value!
 *   [PROMPT] FAIL  — sendMessage threw an error
 *   [PROMPT] PRESS — player pressed a button (action registry resolved)
 *   [PROMPT] TIMEOUT — night timer fired before player responded
 *   [PROMPT] EDIT  — collapsing the keyboard after timeout
 *
 * If you see SEND without a matching SENT/FAIL for >5 seconds, that specific
 * sendMessage call is the source of the socket hang.
 */

"use strict";

const actionRegistry = require("./actionRegistry");

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG LOGGER
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
// GENERIC SELECTION PROMPT — all timing lives here
// ─────────────────────────────────────────────────────────────────────────────

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
  log(
    "PROMPT",
    `Building keyboard key="${key}" options=${options.length} timeout=${timeout}s`,
  );

  let inline_keyboard;
  try {
    inline_keyboard = options.map((opt) => [
      { text: opt.label, callback_data: `${key}:${opt.value}` },
    ]);
  } catch (e) {
    err("PROMPT", `Failed to build keyboard key="${key}" — ${e.message}`);
    return null;
  }

  return new Promise(async (resolve) => {
    let timer;
    let sentMsgId = null;

    // Register BEFORE sending to avoid race conditions
    actionRegistry.register(key, (value) => {
      const elapsed = Date.now() - sendStart;
      log("PROMPT", `PRESS key="${key}" value="${value}" elapsed=${elapsed}ms`);
      clearTimeout(timer);
      resolve(value === "skip" ? null : value);
    });

    log("PROMPT", `SEND userId=${userId} key="${key}"`);
    const sendStart = Date.now();

    try {
      const sent = await bot.telegram.sendMessage(userId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard },
      });
      const sendMs = Date.now() - sendStart;
      log(
        "PROMPT",
        `SENT userId=${userId} key="${key}" msgId=${sent.message_id} in ${sendMs}ms`,
      );

      if (sendMs > 3000) {
        warn(
          "PROMPT",
          `SLOW SEND userId=${userId} took ${sendMs}ms — possible socket congestion`,
        );
      }

      sentMsgId = sent.message_id;
      gameState.activeNightPrompts.set(userId, sentMsgId);
    } catch (e) {
      const sendMs = Date.now() - sendStart;
      err(
        "PROMPT",
        `FAIL userId=${userId} key="${key}" after ${sendMs}ms — ${e.message}`,
      );
      actionRegistry.deregister(key);
      return resolve(null);
    }

    // Night timer
    timer = setTimeout(async () => {
      if (!actionRegistry.has(key)) {
        log(
          "PROMPT",
          `TIMEOUT key="${key}" — already resolved by button press`,
        );
        return;
      }
      log("PROMPT", `TIMEOUT key="${key}" userId=${userId} — deregistering`);
      actionRegistry.deregister(key);

      if (sentMsgId) {
        log(
          "PROMPT",
          `EDIT collapsing keyboard msgId=${sentMsgId} userId=${userId}`,
        );
        const t = Date.now();
        await bot.telegram
          .editMessageReplyMarkup(userId, sentMsgId, undefined, {
            inline_keyboard: [],
          })
          .catch((e) =>
            warn(
              "PROMPT",
              `EDIT failed after ${Date.now() - t}ms — ${e.message}`,
            ),
          );
        log("PROMPT", `EDIT done in ${Date.now() - t}ms`);
      }

      const t2 = Date.now();
      await bot.telegram
        .sendMessage(userId, "⏰ Time's up! No action taken this night.")
        .catch((e) =>
          warn(
            "PROMPT",
            `Timeout notice DM failed after ${Date.now() - t2}ms — ${e.message}`,
          ),
        );
      log(
        "PROMPT",
        `Timeout notice sent to userId=${userId} in ${Date.now() - t2}ms`,
      );

      resolve(null);
    }, timeout * 1000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function buildPlayerOptions(targetIds, gameState) {
  const opts = targetIds.map((id, i) => ({
    label: `${gameState.emojiArray[i]} ${gameState.players.get(id).username}`,
    value: String(id),
  }));
  opts.push({ label: "⏭ No action tonight", value: "skip" });
  return opts;
}

function checkBaiter(targetId, actorId, gameState) {
  const target = gameState.players.get(targetId);
  if (target && target.role === "Baiter") {
    log(
      "PROMPT",
      `checkBaiter: targetId=${targetId} IS the Baiter — actorId=${actorId} gets blown up`,
    );
    return { action: "baited", choice: actorId };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAFIA ROLE COLLECTORS
// ─────────────────────────────────────────────────────────────────────────────

async function collectKill(bot, userId, round, gameState) {
  log("COLLECT", `collectKill userId=${userId}`);
  const targetIds = gameState.playersAlive.filter((id) => {
    const p = gameState.players.get(id);
    return id !== userId && p && p.align !== "Mafia";
  });
  if (targetIds.length === 0) {
    log("COLLECT", `collectKill: no targets for userId=${userId}`);
    return {};
  }

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🔴 <b>Night ${round} — Choose your kill target</b>\n\nSelect a player to eliminate tonight:`,
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

async function collectFrame(bot, userId, round, gameState) {
  log("COLLECT", `collectFrame userId=${userId}`);
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
    text: `🔴 <b>Night ${round} — Choose your frame target</b>\n\nSelect a player to frame:`,
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

async function collectSilence(bot, userId, round, gameState) {
  log("COLLECT", `collectSilence userId=${userId}`);
  const rs = gameState.roleState.Silencer;

  if (rs.workedLastNight) {
    log("COLLECT", `collectSilence: Silencer on cooldown userId=${userId}`);
    rs.workedLastNight = false;
    await bot.telegram
      .sendMessage(userId, "😴 You're too tired to silence anyone tonight.")
      .catch(() => {});
    return {};
  }

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
    text: `🔴 <b>Night ${round} — Choose your silence target</b>\n\nSelect a player to silence:`,
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

async function collectHeal(bot, userId, round, gameState) {
  log("COLLECT", `collectHeal userId=${userId}`);
  const rs = gameState.roleState.Doctor;
  const targetIds = gameState.playersAlive.filter((id) => id !== rs.lastChoice);
  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🟢 <b>Night ${round} — Choose who to protect</b>\n\nSelect a player to save:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "You chose not to save anyone tonight.")
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  rs.lastChoice = targetId;
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

async function collectCheck(bot, userId, round, gameState) {
  log("COLLECT", `collectCheck userId=${userId}`);
  const targetIds = gameState.playersAlive.filter((id) => id !== userId);
  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🟢 <b>Night ${round} — Choose who to investigate</b>\n\nSelect a player:`,
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

async function collectShoot(bot, userId, round, gameState) {
  log("COLLECT", `collectShoot userId=${userId}`);
  const targetIds = gameState.playersAlive.filter((id) => id !== userId);
  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🟢 <b>Night ${round} — Choose who to shoot</b>\n\n⚠️ <i>Shooting a villager causes you to die of guilt!</i>\n\nSelect a player:`,
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

async function collectReveal(bot, userId, round, gameState) {
  log("COLLECT", `collectReveal userId=${userId}`);
  const rs = gameState.roleState.Mayor;
  if (rs.revealed) {
    log("COLLECT", `collectReveal: Mayor already revealed userId=${userId}`);
    return {};
  }
  const player = gameState.players.get(userId);
  if (player && player.silencedLastRound) rs.revealed = false;

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_mayor",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🟢 <b>Night ${round} — Mayor Decision</b>\n\nReveal yourself at tomorrow's meeting?`,
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
  rs.revealed = true;
  gameState.mayor = userId;
  log("COLLECT", `Mayor revealed userId=${userId}`);
  await bot.telegram
    .sendMessage(
      userId,
      "🏛 You will reveal yourself as the <b>Mayor</b> at tomorrow's meeting!",
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "mayor-reveal" };
}

async function collectDistract(bot, userId, round, gameState) {
  log("COLLECT", `collectDistract userId=${userId}`);
  const rs = gameState.roleState.Distractor;
  if (rs.workedLastNight) {
    log("COLLECT", `collectDistract: on cooldown userId=${userId}`);
    rs.workedLastNight = false;
    await bot.telegram
      .sendMessage(userId, "😴 You're too tired to distract anyone tonight.")
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
    text: `🟢 <b>Night ${round} — Choose who to distract</b>\n\nSelect a player:`,
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

async function collectPI(bot, userId, round, gameState) {
  log("COLLECT", `collectPI userId=${userId}`);
  const eligible = gameState.playersAlive.filter((id) => id !== userId);
  if (eligible.length < 2) {
    await bot.telegram
      .sendMessage(userId, "⚠️ Not enough players alive to compare.")
      .catch(() => {});
    return {};
  }

  const sel1 = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_pi1",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🟢 <b>Night ${round} — PI Investigation (1/2)</b>\n\nSelect the <b>first</b> player:`,
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
    timeout: Math.ceil(gameState.settings.nightTime / 2),
    gameState,
    text: `🟢 <b>Night ${round} — PI Investigation (2/2)</b>\n\nComparing against: <b>${target1Name}</b>\n\nSelect the <b>second</b> player:`,
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

async function collectSpy(bot, userId, round, gameState) {
  log("COLLECT", `collectSpy userId=${userId}`);
  const targetIds = gameState.playersAlive.filter((id) => id !== userId);
  if (targetIds.length === 0) return {};

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🟢 <b>Night ${round} — Choose who to watch</b>\n\nSelect a player to follow:`,
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

async function collectJailerKill(bot, userId, round, gameState) {
  log("COLLECT", `collectJailerKill userId=${userId}`);
  const rs = gameState.roleState.Jailer;
  if (rs.killsLeft === 0 || !rs.lastSelection) {
    log(
      "COLLECT",
      `collectJailerKill: no execute ability/prisoner userId=${userId}`,
    );
    return {};
  }

  const prisoner = gameState.players.get(rs.lastSelection);
  if (!prisoner) return {};
  log("COLLECT", `collectJailerKill: prisoner=${prisoner.username}`);

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_jailer",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `⛓ <b>Night ${round} — Execute your prisoner?</b>\n\nYour prisoner is: <b>${prisoner.username}</b>\n\nDo you want to execute them tonight?`,
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
  log("COLLECT", `collectJailerKill: executing prisoner=${prisoner.username}`);
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

async function collectArsonist(bot, userId, round, gameState) {
  log("COLLECT", `collectArsonist userId=${userId}`);
  const rs = gameState.roleState.Arsonist;
  const doused = rs.doused;
  const dousable = gameState.playersAlive.filter(
    (id) => id !== userId && !doused.includes(id),
  );
  const dousedNames =
    doused.length > 0
      ? doused
          .map((id) => gameState.players.get(id)?.username ?? "?")
          .join(", ")
      : "none";

  log(
    "COLLECT",
    `collectArsonist: doused=[${dousedNames}] dousable=${dousable.length}`,
  );

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
    text: `🔵 <b>Night ${round} — Arsonist Action</b>\n\nCurrently doused: <b>${dousedNames}</b>\n\nChoose your action:`,
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
    log("COLLECT", `collectArsonist: IGNITE triggered userId=${userId}`);
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
  rs.doused.push(targetId);
  const target = gameState.players.get(targetId);
  log(
    "COLLECT",
    `collectArsonist: doused userId=${targetId} username=${target?.username}`,
  );
  await bot.telegram
    .sendMessage(userId, `💧 You doused <b>${target.username}</b> tonight.`, {
      parse_mode: "HTML",
    })
    .catch(() => {});
  return { action: "douse", choice: targetId };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

async function collectNightAction(bot, userId, round, gameState) {
  const player = gameState.players.get(userId);
  if (!player || !player.isAlive) {
    warn(
      "COLLECT",
      `collectNightAction: player userId=${userId} not found or dead`,
    );
    return {};
  }

  const role = player.role;
  log(
    "COLLECT",
    `collectNightAction userId=${userId} username=${player.username} role=${role}`,
  );

  const activeGodfatherId = gameState.getActiveGodfather();
  if (activeGodfatherId === userId && role !== "Godfather") {
    log(
      "COLLECT",
      `collectNightAction: userId=${userId} is ACTING Godfather (role=${role})`,
    );
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
    case "Godfather":
      return collectKill(bot, userId, round, gameState);
    case "Mafioso":
      log("COLLECT", `collectNightAction: Mafioso no action userId=${userId}`);
      return {};
    case "Framer":
      return collectFrame(bot, userId, round, gameState);
    case "Silencer":
      return collectSilence(bot, userId, round, gameState);
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
    case "Arsonist":
      return collectArsonist(bot, userId, round, gameState);
    case "Executioner":
    case "Jester":
    case "Baiter":
      log(
        "COLLECT",
        `collectNightAction: ${role} has no night action userId=${userId}`,
      );
      return {};
    default:
      warn(
        "COLLECT",
        `collectNightAction: unknown role="${role}" userId=${userId}`,
      );
      return {};
  }
}

module.exports = { collectNightAction, sendSelectionPrompt };
