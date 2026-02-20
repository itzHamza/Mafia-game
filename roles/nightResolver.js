/**
 * roles/nightResolver.js
 *
 * Resolves all collected night actions in the correct order.
 * Localized for Algerian Arabic (Darija).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const IMAGES_DIR = path.join(__dirname, "..", "images");

// ─────────────────────────────────────────────────────────────────────────────
// DM HELPER (thin wrapper to avoid repetition)
// ─────────────────────────────────────────────────────────────────────────────

async function dm(bot, userId, text, imagePath = null) {
  try {
    if (imagePath && fs.existsSync(imagePath)) {
      if (text.length <= 1024) {
        await bot.telegram.sendPhoto(
          userId,
          { source: fs.createReadStream(imagePath) },
          { caption: text, parse_mode: "HTML" },
        );
      } else {
        await bot.telegram.sendPhoto(userId, {
          source: fs.createReadStream(imagePath),
        });
        await bot.telegram.sendMessage(userId, text, { parse_mode: "HTML" });
      }
    } else {
      await bot.telegram.sendMessage(userId, text, { parse_mode: "HTML" });
    }
  } catch {
    // Player may have blocked the bot — don't crash the game
  }
}

/**
 * Send to group chat.
 */
async function toGroup(bot, groupChatId, text) {
  try {
    await bot.telegram.sendMessage(groupChatId, text, { parse_mode: "HTML" });
  } catch {
    console.error("Failed to send to group chat:", text.substring(0, 80));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JAILER BLOCK CHECK
// ─────────────────────────────────────────────────────────────────────────────

function isJailed(targetId, gameState) {
  return (
    targetId !== null &&
    targetId !== undefined &&
    gameState.roleState.Jailer.lastSelection === targetId
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GODFATHER SUCCESSION NOTIFIER
// ─────────────────────────────────────────────────────────────────────────────

async function notifyGodfatherSuccession(bot, gameState) {
  const hierarchy = ["Mafioso", "Framer", "Silencer"];
  const newGfId = gameState.getActiveGodfather();
  if (!newGfId) return;

  const newGfPlayer = gameState.players.get(newGfId);
  if (!newGfPlayer || newGfPlayer.role === "Godfather") return;

  await dm(
    bot,
    newGfId,
    `🔴 <b>"الزعيم" (Godfather) مات.</b>\n\n` +
      `بما أنك كنت <b>${newGfPlayer.role}</b>، ذرك الحومة خيراتك باش تولي أنت هو "الريس" تاع المافيا.\n` +
      `من وجاي، الكلمة كلمتك وأنت اللي تديسيدي شكون اللي يتصفّى كل ليلة.`,
    path.join(IMAGES_DIR, "godfather.png"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

async function resolveNightActions(roundByRole, gameState, bot, groupChatId) {
  const orderOfActions = [
    "Distractor",
    "Jailer",
    "Framer",
    "Silencer",
    "Godfather",
    "Mafioso",
    "Doctor",
    "Arsonist",
    "Vigilante",
    "Detective",
    "PI",
    "Spy",
    "Mayor",
  ];

  let killedId = null;

  for (const role of orderOfActions) {
    if (!roundByRole.has(role)) continue;

    const { action, actorId } = roundByRole.get(role);

    if (!action || !action.action) continue;

    const actor = gameState.players.get(actorId);
    if (!actor) continue;

    if (actor.distracted) {
      await dm(
        bot,
        actorId,
        `🥴 <b>تلفولك الخيط البارح!</b>\n\n` +
          `بينما كنت حايم في الزناقي، تلاقيت مع واحد مدلك "حبات" مشكوك فيهم ` +
          `ورجعوك للدار دايخ. ما قدرت تدير والو البارح.`,
        path.join(IMAGES_DIR, "distractor.png"),
      );
      actor.distracted = false;
      continue;
    }

    if (!actor.isAlive && role !== "Doctor") continue;

    const choice = action.action;
    let targetId = action.choice;
    let target =
      typeof targetId === "number" ? gameState.players.get(targetId) : null;
    let temp;

    switch (choice) {
      case "distract": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>دار ${target.username} كانت فارغة</b> — ` +
              `كان ديجا في الحبس وما قدرتش تدوخو الليلة.`,
          );
          break;
        }
        temp = gameState.players.get(targetId);
        temp.distracted = true;
        gameState.players.set(targetId, temp);
        break;
      }

      case "execute": {
        const jailTargetId = targetId;
        const jailTarget = gameState.players.get(jailTargetId);

        temp = jailTarget;
        temp.isAlive = false;
        gameState.players.set(jailTargetId, temp);
        gameState.playersAlive = gameState.playersAlive.filter(
          (id) => id !== jailTargetId,
        );
        gameState.deadThisRound.push({ name: jailTargetId, by: "Jailer" });

        await dm(
          bot,
          jailTargetId,
          `⚖️ <b>"الحبّاس" (Jailer) صفيها لك الليلة!</b>\n\n` +
            `ذرك خلاص راك "ودّعت الحومة". تقدر تتبع اللعب بصح ما تقدرش ` +
            `تهدر مع اللي راهم مزالهم حيين.`,
          path.join(IMAGES_DIR, "death.png"),
        );

        if (temp.align === "Village") {
          gameState.roleState.Jailer.killsLeft = 0;
          await dm(
            bot,
            actorId,
            `⚠️ <b>صفيّتها لواحد بريء من ولاد الحومة!</b>\n\n` +
              `ذرك خلاص، طارت عليك وما تقدرش تزيد تقتل حتى "حبسي" واحد آخر، ` +
              `بصح تقدر تقعد تحبس العباد كل ليلة نورمال.`,
          );
        }
        break;
      }

      case "frame": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> راهو في الحبس — ما تقدرش تلصقها فيه الليلة.`,
          );
          break;
        }
        temp = gameState.players.get(targetId);
        temp.wasFramed = true;
        gameState.players.set(targetId, temp);
        break;
      }

      case "silence": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> راهو في الحبس — ما تقدرش تبلعلو فمو الليلة.`,
          );
          break;
        }
        temp = gameState.players.get(targetId);
        temp.silencedThisRound = true;
        gameState.players.set(targetId, temp);
        gameState.deadThisRound.push({ name: targetId, by: "Silencer" });

        await dm(
          bot,
          targetId,
          `🤫 <b>المافيا بلعولك فمك!</b>\n\n` +
            `غدوة ما تقدرش تفتح فمك في "اجتماع الحومة". ` +
            `ولاد حومتك راح يشوفوك بلي راك غايب وما تقدرش تخرج حرف.`,
          path.join(IMAGES_DIR, "silencer.png"),
        );
        break;
      }

      case "kill": {
        if (isJailed(targetId, gameState)) {
          const jailedMsg =
            `🏠 <b>${target.username}</b> ما كانش في الدار الليلة — ` +
            `لقيناه ديجا في "الحبس". التعب تاعكم راح خسارة!`;

          await dm(bot, actorId, jailedMsg);

          const mafiosoId = gameState.currentMafia.Mafioso;
          if (mafiosoId && mafiosoId !== actorId) {
            await dm(bot, mafiosoId, jailedMsg);
          }
          break;
        }

        temp = gameState.players.get(targetId);
        temp.isAlive = false;
        gameState.players.set(targetId, temp);
        gameState.playersAlive = gameState.playersAlive.filter(
          (id) => id !== targetId,
        );
        killedId = targetId;

        gameState.deadThisRound.push({ name: targetId, by: "Mafia" });

        const mafiosoId = gameState.currentMafia.Mafioso;
        if (
          mafiosoId &&
          mafiosoId !== actorId &&
          gameState.players.get(mafiosoId)?.isAlive
        ) {
          await dm(
            bot,
            mafiosoId,
            `🔪 <b>"الريس" (Godfather) عطاك الأوردر باش تصفّيها لـ ${target.username}.</b>\n\n` +
              `روح الليلة وقوم بالواجب.`,
          );
        }

        await dm(
          bot,
          targetId,
          `💀 <b>المافيا هجموا عليك الليلة!</b>\n\n` +
            `${
              temp.role === "Doctor"
                ? "راك تجري وتزرب باش تلحق على الكابة تاع الدوا تاعك!"
                : "راك تحاول تعيط لبرانس تاع السبيطار باش يسلكوك!"
            } ` +
            `هل "الطبيب" راح يلحق عليك في الوقت ولا خلاصت عليك؟`,
          path.join(IMAGES_DIR, "death.png"),
        );

        if (!actor.isAlive) {
          await notifyGodfatherSuccession(bot, gameState);
        }
        break;
      }

      case "kill-vigil": {
        if (!target || !target.isAlive) {
          await dm(
            bot,
            actorId,
            `🔫 <b>كي وصلت لقيت "الضحية" ديجا ميتة! سبقوك ليها.</b>`,
          );
          break;
        }
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> ما كانش في الدار الليلة — ` +
              `راهو بايت في الحبس. الرصاصة تاعك راحت في الريح.`,
          );
          break;
        }

        const align = target.align;
        temp = target;
        temp.isAlive = false;
        gameState.players.set(targetId, temp);
        gameState.playersAlive = gameState.playersAlive.filter(
          (id) => id !== targetId,
        );
        gameState.deadThisRound.push({
          name: targetId,
          by: "Vigilante",
          vigilId: actorId,
        });

        await dm(
          bot,
          targetId,
          `🔫 <b>كلايت قرطاسة من عند "لي يدير الشرع بيدو" (Vigilante)!</b>\n\n` +
            `ذرك خلاص راك "خرجت من الحومة". تقدر تتبع واش راهو يصرى بصح ما تقدرش تهدر مع اللي راهم مزالهم يلعبوا.`,
        );

        let vigilMsg;
        if (align === "Village") {
          vigilMsg =
            `😔 <b>قتلت واحد بريء من الحومة.</b>\n\n` +
            `بعد ما دفنت <b>${target.username}</b>، الضمير تاعك أنبك وما قدرتش تعيش بالذنب.\n\n` +
            `قررت تصفيها لروحك.. راك مت بالزعاف والندامة.`;

          actor.isAlive = false;
          gameState.players.set(actorId, actor);
          gameState.playersAlive = gameState.playersAlive.filter(
            (id) => id !== actorId,
          );
          gameState.deadThisRound.push({
            name: actorId,
            by: "Vigilante-guilt",
          });
        } else if (align === "Mafia") {
          vigilMsg =
            `✅ <b>جبتها في الصواب! قتلت واحد من المافيا.</b>\n\n` +
            `<b>${target.username}</b> كان من المافيا. الحومة نقصت عليها شوكة الليلة.`;
        } else {
          vigilMsg =
            `🔵 <b>${target.username}</b> ما كانش من المافيا، بصح ماشي من ولاد الحومة الزاهدين.\n\n` +
            `ما راهوش معاهم — دبر راسك كيفاش تفهمها.`;
        }
        await dm(bot, actorId, vigilMsg, path.join(IMAGES_DIR, "death.png"));
        break;
      }

      case "check": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>دار ${target.username} كانت فارغة</b> — ` +
              `السيد راهو في الحبس وما قدرتش تتحرى عليه.`,
          );
          break;
        }

        const isSuspect = target.align === "Mafia" || target.wasFramed;

        await dm(
          bot,
          actorId,
          isSuspect
            ? `🔴 <b>نتيجة التحري: ${target.username} راهو مع المافيا!</b>\n\n` +
                `<i>ملاحظة: قادر يكون "لصقوها فيه" (Framed). رد بالك كيفاش تستعمل هذه المعلومة.</i>`
            : `🟢 <b>نتيجة التحري: ${target.username} يبان نظيف وما عندو والو.</b>\n\n` +
                `<i>استحفظ بروحك، إذا هدرت بزاف المافيا راح يحطوك في راسهم.</i>`,
          path.join(IMAGES_DIR, "detective.png"),
        );
        break;
      }

      case "pi-check": {
        const [t1Id, t2Id] = targetId;
        const t1 = gameState.players.get(t1Id);
        const t2 = gameState.players.get(t2Id);

        if (!t1 || !t2) break;

        if (isJailed(t1Id, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${t1.username}</b> راهو في الحبس — ما قدرتش تكمل التحقيق تاعك.`,
          );
          break;
        }
        if (isJailed(t2Id, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${t2.username}</b> راهو في الحبس — ما قدرتش تكمل التحقيق تاعك.`,
          );
          break;
        }

        const t1IsMafia = t1.align === "Mafia" || t1.wasFramed;
        const t2IsMafia = t2.align === "Mafia" || t2.wasFramed;
        const sameSide = t1IsMafia === t2IsMafia;

        await dm(
          bot,
          actorId,
          sameSide
            ? `🟢 <b>${t1.username}</b> و <b>${t2.username}</b> يبانو بلي راهم في <b>نفس الجهة</b>.\n\n` +
                `<i>ما تدريش شكون فيهم المليح وشكون القبيح، بصح راهم كيف كيف.</i>`
            : `🔴 <b>${t1.username}</b> و <b>${t2.username}</b> راهم في <b>جهات مختلفة</b>.\n\n` +
                `<i>واحد فيهم قادر يكون مافيا والاخر لا لا، ولا واحد فيهم تلصقت فيه التهمة.</i>`,
          path.join(IMAGES_DIR, "pi.png"),
        );
        break;
      }

      case "spy-check": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> راهو في الحبس — ما قدرتش تبعو الليلة.`,
          );
          break;
        }

        const watchedRole = target.role;
        const watchedEntry = roundByRole.get(watchedRole);
        let visitedName = null;

        if (watchedEntry) {
          const watchedAction = watchedEntry.action;

          if (watchedRole === "Mafioso" && roundByRole.has("Godfather")) {
            const gfEntry = roundByRole.get("Godfather");
            if (
              gfEntry?.action?.choice &&
              typeof gfEntry.action.choice === "number"
            ) {
              const visited = gameState.players.get(gfEntry.action.choice);
              visitedName = visited?.username ?? null;
            }
          } else if (
            watchedAction?.choice &&
            typeof watchedAction.choice === "number"
          ) {
            const visited = gameState.players.get(watchedAction.choice);
            visitedName = visited?.username ?? null;
          }
        }

        const spyPlayer = gameState.players.get(actorId);
        let spyMsg;

        if (visitedName === spyPlayer.username) {
          spyMsg =
            `👁 <b>السيد اللي كنت تعس فيه جا لدارك أنت!</b>\n\n` +
            `خمّم مليح علاش جا عندك...`;
        } else if (visitedName) {
          spyMsg =
            `👁 <b>شفت الضحية تاعك زار الدار تاع ${visitedName}.</b>\n\n` +
            `أحسب واش كاين... واش راح يدير تماك؟`;
        } else {
          spyMsg =
            `👁 <b>الهدف تاعك ما خرج من الدار الليلة.</b>\n\n` +
            `يا راهو عاقل، يا راهو يخبي في كاش حاجة...`;
        }
        await dm(bot, actorId, spyMsg, path.join(IMAGES_DIR, "spy.png"));
        break;
      }

      case "heal": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target?.username}</b> راهو في الحبس — ما قدرتش تلحق عليه تداويه.`,
          );
          killedId = null;
          break;
        }

        const healTarget = gameState.players.get(targetId);

        if (actorId === targetId && !actor.isAlive) {
          actor.isAlive = true;
          gameState.players.set(actorId, actor);
          gameState.playersAlive.push(actorId);
          gameState.deadThisRound.push({ name: actorId, by: "Doctor" });

          await dm(
            bot,
            actorId,
            `✅ <b>سلكت روحك!</b>\n\n` +
              `المافيا هجموا عليك، بصح الخبرة تاعك خلاتك تداوي جراحك وتمنع من الموت.`,
            path.join(IMAGES_DIR, "health.png"),
          );
        } else if (
          actor.isAlive &&
          healTarget &&
          !healTarget.isAlive &&
          targetId === killedId
        ) {
          healTarget.isAlive = true;
          gameState.players.set(targetId, healTarget);
          gameState.playersAlive.push(targetId);
          gameState.deadThisRound.push({ name: targetId, by: "Doctor" });

          await dm(
            bot,
            actorId,
            `✅ <b>سلكت ${healTarget.username}!</b>\n\n` +
              `المافيا كانو راح يصفوها له، بصح أنت لحقت في الوقت المناسب.`,
            path.join(IMAGES_DIR, "health.png"),
          );
          await dm(
            bot,
            targetId,
            `💊 <b>"الطبيب" (Doctor) سلكك!</b>\n\n` +
              `المافيا هجموا عليك البارح، بصح الطبيب جا وجرى بك ومنعك من الموت.`,
            path.join(IMAGES_DIR, "health.png"),
          );
        } else if (killedId) {
          const deadPerson = gameState.players.get(killedId);
          const isDocSelf = killedId === actorId;
          await dm(
            bot,
            killedId,
            `💀 <b>${isDocSelf ? "ما قدرتش تلحق على الكابة تاع الدوا تاعك!" : "الطبيب ما قدرش يلحق عليك في الوقت!"}</b>\n\n` +
              `خلاص، راك مت. تقدر تتبع واش صاري بصح بلا ما تهدر مع الحيين.`,
            path.join(IMAGES_DIR, "death.png"),
          );
        }

        killedId = null;
        break;
      }

      case "mayor-reveal": {
        const mayorPlayer = gameState.players.get(actorId);
        if (!mayorPlayer.silencedThisRound) {
          gameState.deadThisRound.push({ name: actorId, by: "Mayor" });
        } else {
          gameState.roleState.Mayor.revealed = false;
          gameState.mayor = "";
          await dm(
            bot,
            actorId,
            `🤫 <b>كنت حاب تكشف روحك بصح المافيا بلعولك فمك!</b>\n\n` +
              `محاولة الكشف تاعك فشلت. جرب غدوة إذا قعدت حي.`,
          );
        }
        break;
      }

      case "douse": {
        // Recorded in prompt layer
        break;
      }

      case "ignite": {
        const rs = gameState.roleState.Arsonist;
        const dousedIds = [...rs.doused];
        const burned = [];

        for (const dousedId of dousedIds) {
          const dousedPlayer = gameState.players.get(dousedId);
          if (!dousedPlayer || !dousedPlayer.isAlive) continue;

          if (gameState.roleState.Jailer.lastSelection === dousedId) {
            await dm(
              bot,
              actorId,
              `🏠 <b>${dousedPlayer.username}</b> كان في الحبس ومنع من النار تاعك!`,
            );
            continue;
          }

          dousedPlayer.isAlive = false;
          gameState.players.set(dousedId, dousedPlayer);
          gameState.playersAlive = gameState.playersAlive.filter(
            (id) => id !== dousedId,
          );
          burned.push(dousedId);

          await dm(
            bot,
            dousedId,
            `🔥 <b>دارك شعلت فيها النار وأنت راقد!</b>\n\n` +
              `"مول الشاليمو" (Arsonist) حرقك. تقدر تقعد تفرج بصح ما تقدرش تهدر.`,
          );
        }

        rs.doused = rs.doused.filter(
          (id) => id !== gameState.roleState.Jailer.lastSelection,
        );

        gameState.deadThisRound.push({
          name: actorId,
          by: "Arsonist",
          killed: burned,
        });
        break;
      }

      case "baited": {
        gameState.roleState.Baiter.baitedCount++;
        gameState.deadThisRound.push({ name: actorId, by: "Baiter" });

        temp = actor;
        temp.isAlive = false;
        gameState.players.set(actorId, temp);
        gameState.playersAlive = gameState.playersAlive.filter(
          (id) => id !== actorId,
        );

        await dm(
          bot,
          actorId,
          `💥 <b>تفركعت فيك بومبة عند "مول الفخ" (Baiter)!</b>\n\n` +
            `دخلت للدار الغالطة. ذرك خلاص، راك ودعت الحومة.`,
          path.join(IMAGES_DIR, "death.png"),
        );
        break;
      }

      default:
        break;
    }
  }
}

module.exports = { resolveNightActions, notifyGodfatherSuccession };
