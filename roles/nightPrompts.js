/**
 * roles/nightPrompts.js
 */

"use strict";

const actionRegistry = require("./actionRegistry");
const { log, warn, err } = require("../logger");

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC SELECTION PROMPT
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

  let inline_keyboard;
  try {
    inline_keyboard = options.map((opt) => [
      { text: opt.label, callback_data: `${key}:${opt.value}` },
    ]);
  } catch (e) {
    err("NIGHT", `Failed to build action keyboard: ${e.message}`);
    return null;
  }

  return new Promise(async (resolve) => {
    let timer;
    let sentMsgId = null;

    // Register before sending to avoid race conditions
    actionRegistry.register(key, (value) => {
      clearTimeout(timer);
      resolve(value === "skip" ? null : value);
    });

    try {
      const sent = await bot.telegram.sendMessage(userId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard },
      });
      sentMsgId = sent.message_id;
      gameState.activeNightPrompts.set(userId, sentMsgId);
    } catch (e) {
      const player = gameState.players.get(userId);
      err(
        "NIGHT",
        `Could not send action prompt to ${player?.username ?? userId}: ${e.message}`,
      );
      actionRegistry.deregister(key);
      return resolve(null);
    }

    // Night timer — fires if player doesn't respond in time
    timer = setTimeout(async () => {
      if (!actionRegistry.has(key)) return; // already resolved by button press
      actionRegistry.deregister(key);

      const player = gameState.players.get(userId);
      log(
        "NIGHT",
        `${player?.username ?? userId} ran out of time — no action taken`,
      );

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

function buildPlayerOptions(targetIds, gameState) {
  const opts = targetIds.map((id, i) => ({
    label: `${gameState.emojiArray[i]} ${gameState.players.get(id).username}`,
    value: String(id),
  }));
  opts.push({ label: "⏭ مكاش خدمة الليلة (تخطي)", value: "skip" });
  return opts;
}

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
    text: `🔴 <b>الليلة رقم ${round} — خيّر الضحية تاعك</b>\n\nاسمي واحد باش تصفّيها له الليلة:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خيرت باش ما تصفّيها لحتّى واحد الليلة. جازت ليلة بيضا.</b>",
        {
          parse_mode: "HTML",
        },
      )
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `🔪 <b>قررت باش تصفّيها لـ ${target.username} الليلة. الخدمة راهي بدات!</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "kill", choice: targetId };
}

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
    text: `🔴 <b>الليلة رقم ${round} — خيّر شكون حاب تغرق</b>\n\nاسمي واحد باش تلصقلو التهمة وتخلطها على لانسبيكتور:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خيرت باش ما تلصق التهمة لحتّى واحد الليلة. خليت الحالة صافية.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
  const target = gameState.players.get(targetId);
  await bot.telegram
      .sendMessage(
        userId,
        ` <b>قررت باش تلصقلو التهمة على ${target.username} الليلة.</b>`,
        { parse_mode: "HTML" },
      )
    .catch(() => {});
  return { action: "frame", choice: targetId };
}

async function collectSilence(bot, userId, round, gameState) {
  const rs = gameState.roleState.Silencer;
  if (rs.workedLastNight) {
    rs.workedLastNight = false;
    await bot.telegram
      .sendMessage(
        userId,
        "<b>😴 راك عيّان بزاف الليلة، ما تقدر تبلّع الفم لحتّى واحد.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }

  const targetIds = gameState.playersAlive.filter(
    (id) => id !== userId && !rs.silencedSoFar.includes(id),
  );
  if (targetIds.length === 0) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>مكاش شكون تقدر تبلعلو فمه الليلة، كامل راهم 'خارج التغطية'.</b>",
        { parse_mode: "HTML" },
      )
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
          text: `🔴 <b>الليلة رقم ${round} — خيّر شكون حاب تبلعلو فمه</b>\n\nاسمي واحد باش تبلعلو فمه:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خيرت باش ما تبلعلو فمه لحتّى واحد الليلة. خليت الحالة صافية.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
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
      `🤫 <b>خلاص، قررت تبلّع الفم لـ ${target.username} الليلة. غدوة يقعد غير يشوف!</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "silence", choice: targetId };
}

// ─────────────────────────────────────────────────────────────────────────────
// VILLAGE ROLE COLLECTORS
// ─────────────────────────────────────────────────────────────────────────────

async function collectHeal(bot, userId, round, gameState) {
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
    text: `🟢 <b>الليلة رقم ${round} — خيّر شكون تسلك</b>\n\nاسمي واحد باش تحميه وتمنعو من الموت الليلة:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خيرت باش ما تسلك لحتّى واحد الليلة. خليت الحالة صافية.</b>",
        { parse_mode: "HTML" },
      )
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
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `💊 <b>خلاص، قررت تحمي ${target.username} الليلة.</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "heal", choice: targetId };
}

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
    text: `🟢 <b>الليلة رقم ${round} — خيّر شكون تفتّش</b>\n\nاسمي واحد باش لانسبيكتور يعرف قرايتو:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خيرت باش ما تفتّش لحتّى واحد الليلة. خليت الحالة صافية.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `🔍 <b>خلاص، قررت تفتّش ${target.username} الليلة.</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "check", choice: targetId };
}

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
    text: `🟢 <b>الليلة رقم ${round} — خيّر شكون تيري عليه</b>\n\n⚠️ <i>رد بالك: إذا تيريت في واحد بريء، تموت بـ 'الغُلب' وتأنيب الضمير!</i>\n\nاسمي واحد باش تصفّيها له:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خبّيت المكحلة ومكحلتهاش الليلة. خيرت باش ما تيري في حتى واحد.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `🔫 <b>خلاص، قررت تيري ${target.username} الليلة.</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "kill-vigil", choice: targetId };
}

async function collectReveal(bot, userId, round, gameState) {
  const rs = gameState.roleState.Mayor;
  if (rs.revealed) return {};
  const player = gameState.players.get(userId);
  if (player && player.silencedLastRound) rs.revealed = false;

  const selection = await sendSelectionPrompt({
    bot,
    userId,
    round,
    prefix: "na_mayor",
    timeout: gameState.settings.nightTime,
    gameState,
    text: `🟢 <b>الليلة رقم ${round} — قرار المير (Mayor)</b>\n\nحاب تبيّن هويتك لولاد الحومة في اجتماع غدوة؟`,
    options: [
      { label: "✅ Yes — reveal myself tomorrow", value: "yes" },
      { label: "❌ No — stay hidden", value: "no" },
    ],
  });

  if (!selection || selection === "no") {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>🏛 خيرت باش تقعد متخبي غدوة. واحد ما علبالو بلي أنت هو المير.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  rs.revealed = true;
  gameState.mayor = userId;
  await bot.telegram
    .sendMessage(
      userId,
          "🏛 <b>أنت المير، وستُبيّن هويتك غدوة في اجتماع الحومة.</b>",
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "mayor-reveal" };
}

async function collectDistract(bot, userId, round, gameState) {
  const rs = gameState.roleState.Distractor;
  if (rs.workedLastNight) {
    rs.workedLastNight = false;
    await bot.telegram
      .sendMessage(
        userId,
        "<b>😴 راك فاشل الليلة، المخلط عيا... ما تقدر تتلف الخيط لحتّى واحد.</b>",
        { parse_mode: "HTML" },
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
        text: `🟢 <b>الليلة رقم ${round} — خيّر شكون تخلط عليه</b>\n\nاسمي واحد باش تصفّيها له:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خبّيت المكحلة ومكحلتهاش الليلة. خيرت باش ما تخلطش على حتى واحد.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
  const target = gameState.players.get(targetId);
  rs.workedLastNight = true;
  await bot.telegram
    .sendMessage(
      userId,
      `🥴 <b>خلاص، قررت تخلط على ${target.username} الليلة.</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "distract", choice: targetId };
}

async function collectPI(bot, userId, round, gameState) {
  const eligible = gameState.playersAlive.filter((id) => id !== userId);
  if (eligible.length < 2) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>⚠️ مكاش غاشي بزاف باش تقارن بيناتهم، الحالة راهي فارغة.</b>",
        { parse_mode: "HTML" },
      )
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
    text: `🟢 <b>الليلة رقم ${round} — تحقق من الـ PI (1/2)</b>\n\nاختر <b>اللاعب الأول</b>:`,
    options: buildPlayerOptions(eligible, gameState),
  });

  if (!sel1) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>خبّيت المكحلة ومكحلتهاش الليلة. خيرت باش ما تقارنش بيناتهم.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  const target1Id = Number(sel1);
  const baited1 = checkBaiter(target1Id, userId, gameState);
  if (baited1) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited1;
  }

  const eligible2 = eligible.filter((id) => id !== target1Id);
  if (eligible2.length === 0) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>⚠️ مكاش غاشي بزاف باش تقارن بيناتهم، الحالة راهي فارغة.</b>",
        { parse_mode: "HTML" },
      )
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
    text: `🟢 <b>الليلة رقم ${round} — لانسبيكتور الخاص (2/2)</b>\n\nراك تقارن مع: <b>${target1Name}</b>\n\nخيّر <b>الشخص الثاني</b> باش نعرفوا الحقيقة:`,
    options: buildPlayerOptions(eligible2, gameState),
  });

  if (!sel2) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>التحقيق ما كملش — ما خيرتش الشخص الثاني باش تقارن بيناتهم.</b>",
        { parse_mode: "HTML" },
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
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited2;
  }

  const target2Name = gameState.players.get(target2Id).username;
  await bot.telegram
    .sendMessage(
      userId,
      `🔍 <b>قررت باش تقارن بين ${target1Name} و ${target2Name}. الليلة يبان الساس!</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "pi-check", choice: [target1Id, target2Id] };
}

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
    text: `🟢 <b>الليلة رقم ${round} — خيّر شكون تعسّ</b>\n\nاسمي واحد باش تتبعه وتشوف شكون راح يزوره:`,
    options: buildPlayerOptions(targetIds, gameState),
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(
        userId,
        "<b>ما خيرتش أحد باش تتبعه الليلة.</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  const targetId = Number(selection);
  const baited = checkBaiter(targetId, userId, gameState);
  if (baited) {
    await bot.telegram
      .sendMessage(
        userId,
        "💥 <b>دخلت لدار الجزار (Baiter) — طرطق عليك القاز وراحت فيك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
  const target = gameState.players.get(targetId);
  await bot.telegram
    .sendMessage(
      userId,
      `👁 <b>اخترت تتبع ${target.username} الليلة.</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "spy-check", choice: targetId };
}

async function collectJailerKill(bot, userId, round, gameState) {
  const rs = gameState.roleState.Jailer;
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
    text: `⛓ <b>الليلة رقم ${round} — تصفّيها للحبسي؟</b>\n\nالحبسي اللي راهو عندك هو: <b>${prisoner.username}</b>\n\nحاب تصفّيها له الليلة ولا تطلق صراحو؟`,
    options: [
      { label: `⚖️ Yes — execute ${prisoner.username}`, value: "yes" },
      { label: "🔓 No — release them", value: "no" },
    ],
  });

  if (!selection || selection === "no") {
    await bot.telegram
      .sendMessage(
        userId,
        `🔓 <b>ما اخترتش تصفّي ${prisoner.username} الليلة.</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return {};
  }
  await bot.telegram
    .sendMessage(
      userId,
      `⚖️ <b>اختار تصفّي ${prisoner.username} الليلة.</b>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  return { action: "execute", choice: rs.lastSelection };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEUTRAL ROLE COLLECTORS
// ─────────────────────────────────────────────────────────────────────────────

async function collectArsonist(bot, userId, round, gameState) {
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

  const options = [
    {
      label: `🔥 شعل النار في كامل المشمخين (${doused.length})`,
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
    text: `🔵 <b>الليلة رقم ${round} — مول الليسونس (Arsonist)</b>\n\nاللي راهم "مشمخين" ذرك: <b>${dousedNames}</b>\n\nواش راك ناوي تدير الليلة؟`,
    options,
  });

  if (!selection) {
    await bot.telegram
      .sendMessage(userId, "<b>ما اخترتش تدير الليلة.</b>", { parse_mode: "HTML" })
      .catch(() => {});
    return {};
  }

  if (selection === "ignite") {
    if (doused.length === 0) {
      await bot.telegram
        .sendMessage(
          userId,
          "<b>⚠️ مكاش حتى واحد 'مشمخ' بالليسونس باش تشعل فيه النار!</b>",
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      return {};
    }
    await bot.telegram
      .sendMessage(
        userId,
        `🔥 <b>يا محاينك! شعلت النار في ${doused.length} اللي كانوا مشمخين الليلة!</b>`,
        { parse_mode: "HTML" },
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
        "💥 <b>لقد زرت بيت البائس — وتم تفجيرك!</b>",
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return baited;
  }
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
// ─────────────────────────────────────────────────────────────────────────────

async function collectNightAction(bot, userId, round, gameState) {
  const player = gameState.players.get(userId);
  if (!player || !player.isAlive) return {};

  const role = player.role;

  const activeGodfatherId = gameState.getActiveGodfather();
  if (activeGodfatherId === userId && role !== "Godfather") {
    await bot.telegram
      .sendMessage(
        userId,
        `🔴 <b>بما أنك راك 'البوص' الليلة، لازم تعطينا الأمر: شكون اللي راح يتصفّى؟</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return collectKill(bot, userId, round, gameState);
  }

  switch (role) {
    case "Godfather":
      return collectKill(bot, userId, round, gameState);
    case "Mafioso":
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
      return {}; // No night action
    default:
      warn(
        "NIGHT",
        `Unknown role "${role}" for player ${player.username} — no action sent`,
      );
      return {};
  }
}

module.exports = { collectNightAction, sendSelectionPrompt };
