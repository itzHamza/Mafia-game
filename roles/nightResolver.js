/**
 * roles/nightResolver.js
 *
 * Resolves all collected night actions in the correct order.
 *
 * Discord equivalent: the Promise.all(promises).then(() => { ... switch ... })
 * block inside nightActions() in commands/start.js.
 *
 * Key differences from original:
 *   - All player lookups use numeric user IDs (not Discord username#tag strings)
 *   - searchableUsers[id].send(msg)  → bot.telegram.sendMessage(userId, text)
 *   - message.guild.members.resolve(id).send()  → same as above
 *   - gamedata.game.game.deadThisRound  → gameState.deadThisRound
 *   - gamedata.game.game.playersAlive   → gameState.playersAlive
 *   - Arsonist doused-list filter bug fixed (see "ignite" case)
 *   - "Jailer".lastSelection typo fixed (see "ignite" case)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const IMAGES_DIR = path.join(__dirname, "..", "images");

// ─────────────────────────────────────────────────────────────────────────────
// DM HELPER (thin wrapper to avoid repetition)
// Discord equivalent: searchableUsers[player.id].send(embed)
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
 * Discord equivalent: channel.send(embed) where channel = the text channel
 */
async function toGroup(bot, groupChatId, text) {
  try {
    await bot.telegram.sendMessage(groupChatId, text, { parse_mode: "HTML" });
  } catch {
    // Group chat issues are non-fatal — log and continue
    console.error("Failed to send to group chat:", text.substring(0, 80));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JAILER BLOCK CHECK
// Discord equivalent: if (action.choice && gamedata.villageRoles["Jailer"].lastSelection === action.choice)
// Reused for almost every action type.
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
// Discord equivalent: gamedata.mafiaRoles.updateGodfather(guild)
// ─────────────────────────────────────────────────────────────────────────────

async function notifyGodfatherSuccession(bot, gameState) {
  const hierarchy = ["Mafioso", "Framer", "Silencer"];
  const newGfId = gameState.getActiveGodfather();
  if (!newGfId) return;

  const newGfPlayer = gameState.players.get(newGfId);
  if (!newGfPlayer || newGfPlayer.role === "Godfather") return; // original GF still alive

  await dm(
    bot,
    newGfId,
    `🔴 <b>The Godfather has died.</b>\n\n` +
      `As ${newGfPlayer.role}, you have been chosen to lead the Mafia.\n` +
      `You will now be responsible for ordering each night's kill.`,
    path.join(IMAGES_DIR, "godfather.png"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process all night actions in priority order and mutate gameState accordingly.
 *
 * @param {Map<string, {action: Object, actorId: number}>} roundByRole
 *   Maps role name → { action: {action, choice}, actorId: userId }
 *   Discord equivalent: roundByRole Map in nightActions()
 * @param {Object} gameState
 * @param {Object} bot         Telegraf bot instance (for sending DMs)
 * @param {number} groupChatId Telegram group chat ID (for announcements)
 */
async function resolveNightActions(roundByRole, gameState, bot, groupChatId) {
  // ── Action priority order ─────────────────────────────────────────────────
  // Preserved exactly from original start.js.
  // Discord equivalent: const orderOfActions = [["Distractor","Village"], ...]
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

  // `killedId` tracks the Mafia's kill target so the Doctor can reference it.
  // Discord equivalent: let killed; set in "kill" case, cleared in "heal" case.
  let killedId = null;

  for (const role of orderOfActions) {
    if (!roundByRole.has(role)) continue;

    const { action, actorId } = roundByRole.get(role);

    // No action taken by this role
    if (!action || !action.action) continue;

    const actor = gameState.players.get(actorId);
    if (!actor) continue;

    // ── Distracted check ──────────────────────────────────────────────────
    // Discord equivalent:
    //   if (actor.distracted) { send distractedMessage; actor.distracted = false; continue; }
    if (actor.distracted) {
      await dm(
        bot,
        actorId,
        `🥴 <b>You were distracted last night!</b>\n\n` +
          `While wandering the streets, someone offered you suspicious pills ` +
          `and brought you home. You couldn't act last night.`,
        path.join(IMAGES_DIR, "distractor.png"),
      );
      actor.distracted = false;
      continue;
    }

    // ── Dead actor check ──────────────────────────────────────────────────
    // Original allowed the Doctor to act even if they had died (self-heal case),
    // but skipped all other dead actors.
    if (!actor.isAlive && role !== "Doctor") continue;

    const choice = action.action;
    let targetId = action.choice; // may be a number, array, or string
    let target =
      typeof targetId === "number" ? gameState.players.get(targetId) : null;
    let temp;

    switch (choice) {
      // ── DISTRACT ──────────────────────────────────────────────────────
      // Discord equivalent: case "distract"
      case "distract": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}'s house was empty</b> — ` +
              `they couldn't be distracted tonight.`,
          );
          break;
        }
        temp = gameState.players.get(targetId);
        temp.distracted = true;
        gameState.players.set(targetId, temp);
        break;
      }

      // ── JAILER EXECUTE ────────────────────────────────────────────────
      // Discord equivalent: case "execute"
      // Processed before kill so the prisoner is removed before Mafia targets are checked.
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
          `⚖️ <b>You were executed by the Jailer!</b>\n\n` +
            `Now that you're dead, you may spectate but not communicate ` +
            `with living players.`,
          path.join(IMAGES_DIR, "death.png"),
        );

        // If Jailer executed a villager they permanently lose execute ability
        // Discord equivalent: if (temp.align === "Village") { that.killsLeft = 0; }
        if (temp.align === "Village") {
          gameState.roleState.Jailer.killsLeft = 0;
          await dm(
            bot,
            actorId,
            `⚠️ <b>You executed a villager!</b>\n\n` +
              `You've permanently lost your ability to execute prisoners, ` +
              `but you can still jail them each night.`,
          );
        }
        break;
      }

      // ── FRAME ────────────────────────────────────────────────────────
      // Discord equivalent: case "frame"
      case "frame": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> was in jail — they couldn't be framed.`,
          );
          break;
        }
        temp = gameState.players.get(targetId);
        temp.wasFramed = true;
        gameState.players.set(targetId, temp);
        break;
      }

      // ── SILENCE ───────────────────────────────────────────────────────
      // Discord equivalent: case "silence"
      case "silence": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> was in jail — they couldn't be silenced.`,
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
          `🤫 <b>You were silenced by the Mafia!</b>\n\n` +
            `You will be unable to participate in tomorrow's Town Hall meeting. ` +
            `Your fellow villagers will see you as absent.`,
          path.join(IMAGES_DIR, "silencer.png"),
        );
        break;
      }

      // ── MAFIA KILL ────────────────────────────────────────────────────
      // Discord equivalent: case "kill"
      case "kill": {
        if (isJailed(targetId, gameState)) {
          const jailedMsg =
            `🏠 <b>${target.username}</b> was not home tonight — ` +
            `they were taken to jail. Your kill was wasted.`;
          await dm(bot, actorId, jailedMsg);

          // Notify Mafioso too (they carry out the kill physically)
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
        killedId = targetId; // Doctor will reference this

        gameState.deadThisRound.push({ name: targetId, by: "Mafia" });

        // Notify the Mafioso of the kill order
        // Discord equivalent: searchableUsers[gamedata.players.get(mafioso).id].send(...)
        const mafiosoId = gameState.currentMafia.Mafioso;
        if (
          mafiosoId &&
          mafiosoId !== actorId &&
          gameState.players.get(mafiosoId)?.isAlive
        ) {
          await dm(
            bot,
            mafiosoId,
            `🔪 <b>The Godfather has ordered you to attack ${target.username}.</b>\n\n` +
              `Carry out the hit tonight.`,
          );
        }

        // Notify victim they were attacked (Doctor may still save them)
        await dm(
          bot,
          targetId,
          `💀 <b>You were attacked by the Mafia!</b>\n\n` +
            `${
              temp.role === "Doctor"
                ? "You scramble to grab your first-aid kit!"
                : "You reach for the Mafiaville Emergency Line!"
            } ` +
            `Will the Doctor arrive in time?`,
          path.join(IMAGES_DIR, "death.png"),
        );

        // Check for Godfather succession if the attacker themselves died somehow
        if (!actor.isAlive) {
          await notifyGodfatherSuccession(bot, gameState);
        }
        break;
      }

      // ── VIGILANTE KILL ────────────────────────────────────────────────
      // Discord equivalent: case "kill-vigil"
      case "kill-vigil": {
        if (!target || !target.isAlive) {
          await dm(
            bot,
            actorId,
            `🔫 <b>Your target was already dead when you arrived!</b>`,
          );
          break;
        }
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> was not home tonight — ` +
              `they were in jail. Your shot missed.`,
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
          `🔫 <b>You were shot by the Vigilante!</b>\n\n` +
            `Now that you're dead, you may spectate but not communicate with living players.`,
        );

        // Vigilante feedback — and self-kill on villager mistake
        // Discord equivalent: the align === "Village" branch in case "kill-vigil"
        let vigilMsg;
        if (align === "Village") {
          vigilMsg =
            `😔 <b>You shot a villager.</b>\n\n` +
            `After giving <b>${target.username}</b> a proper burial, ` +
            `you load your gun for one final shot: yourself.\n\n` +
            `You have died of guilt.`;

          // Vigilante dies
          actor.isAlive = false;
          gameState.players.set(actorId, actor);
          gameState.playersAlive = gameState.playersAlive.filter(
            (id) => id !== actorId,
          );
          // Vigilante death is announced in dayTime (not added to deadThisRound here,
          // since the original also adds it implicitly via playersAlive filter)
          gameState.deadThisRound.push({
            name: actorId,
            by: "Vigilante-guilt",
          });
        } else if (align === "Mafia") {
          vigilMsg =
            `✅ <b>You shot a Mafia member!</b>\n\n` +
            `<b>${target.username}</b> was Mafia. The village is safer tonight.`;
        } else {
          vigilMsg =
            `🔵 <b>${target.username}</b> was not Mafia, but also not a Villager.\n\n` +
            `They didn't align with the town — the implications are yours to interpret.`;
        }
        await dm(bot, actorId, vigilMsg, path.join(IMAGES_DIR, "death.png"));
        break;
      }

      // ── DETECTIVE CHECK ───────────────────────────────────────────────
      // Discord equivalent: case "check"
      case "check": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}'s house was empty</b> — ` +
              `they couldn't be investigated.`,
          );
          break;
        }

        // Framed players appear as Mafia to the Detective
        // Discord equivalent: suspect.align === "Mafia" || suspect.wasFramed
        const isSuspect = target.align === "Mafia" || target.wasFramed;

        await dm(
          bot,
          actorId,
          isSuspect
            ? `🔴 <b>Investigation result: ${target.username} is in the Mafia!</b>\n\n` +
                `<i>Note: they may have been framed. Consider this when sharing ` +
                `your findings with the town.</i>`
            : `🟢 <b>Investigation result: ${target.username} appears to be clear.</b>\n\n` +
                `<i>Be careful — revealing this publicly may make you a target.</i>`,
          path.join(IMAGES_DIR, "detective.png"),
        );
        break;
      }

      // ── PI CHECK ──────────────────────────────────────────────────────
      // Discord equivalent: case "pi-check"
      case "pi-check": {
        const [t1Id, t2Id] = targetId; // action.choice is [userId, userId]
        const t1 = gameState.players.get(t1Id);
        const t2 = gameState.players.get(t2Id);

        if (!t1 || !t2) break;

        // Jailed check for either target
        if (isJailed(t1Id, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${t1.username}</b> was in jail — investigation incomplete.`,
          );
          break;
        }
        if (isJailed(t2Id, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${t2.username}</b> was in jail — investigation incomplete.`,
          );
          break;
        }

        // Same side if both are Mafia (or framed) or both are not
        // Discord equivalent: suspects.map(sus => sus.align === "Mafia" || sus.wasFramed)
        const t1IsMafia = t1.align === "Mafia" || t1.wasFramed;
        const t2IsMafia = t2.align === "Mafia" || t2.wasFramed;
        const sameSide = t1IsMafia === t2IsMafia;

        await dm(
          bot,
          actorId,
          sameSide
            ? `🟢 <b>${t1.username}</b> and <b>${t2.username}</b> appear to be ` +
                `on the <b>same side</b>.\n\n` +
                `<i>You don't know which side — keep that in mind.</i>`
            : `🔴 <b>${t1.username}</b> and <b>${t2.username}</b> appear to be ` +
                `on <b>different sides</b>.\n\n` +
                `<i>One may be Mafia or framed — you still don't know which.</i>`,
          path.join(IMAGES_DIR, "pi.png"),
        );
        break;
      }

      // ── SPY CHECK ─────────────────────────────────────────────────────
      // Discord equivalent: case "spy-check"
      case "spy-check": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target.username}</b> was in jail — you couldn't follow them.`,
          );
          break;
        }

        const watchedRole = target.role;
        const watchedEntry = roundByRole.get(watchedRole);
        let visitedName = null;

        if (watchedEntry) {
          const watchedAction = watchedEntry.action;

          // Special case: Mafioso when Godfather is alive
          // Spy watching Mafioso should see where the Godfather SENT them (the kill target)
          // Discord equivalent: else if (selectionRole === "Mafioso") { godfatherChoice = ... }
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
            // Standard case: look up where the watched player went
            const visited = gameState.players.get(watchedAction.choice);
            visitedName = visited?.username ?? null;
          }
        }

        const spyPlayer = gameState.players.get(actorId);
        let spyMsg;

        if (visitedName === spyPlayer.username) {
          spyMsg =
            `👁 <b>Your target came to YOUR house!</b>\n\n` +
            `Figure out why they visited you...`;
        } else if (visitedName) {
          spyMsg =
            `👁 <b>You saw your target visit ${visitedName}'s house.</b>\n\n` +
            `Consider what that means...`;
        } else {
          spyMsg =
            `👁 <b>Your target didn't go anywhere last night.</b>\n\n` +
            `Maybe that clears their name... or does it?`;
        }
        await dm(bot, actorId, spyMsg, path.join(IMAGES_DIR, "spy.png"));
        break;
      }

      // ── DOCTOR HEAL ───────────────────────────────────────────────────
      // Discord equivalent: case "heal"
      // Three sub-cases from original preserved exactly:
      //   1. Doctor chose self AND was the kill target → self-save
      //   2. Doctor chose someone else AND that person was the kill target → save
      //   3. Kill happened but Doctor healed wrong person → too late
      case "heal": {
        if (isJailed(targetId, gameState)) {
          await dm(
            bot,
            actorId,
            `🏠 <b>${target?.username}</b> was in jail — you couldn't reach them.`,
          );
          killedId = null;
          break;
        }

        const healTarget = gameState.players.get(targetId);

        // Case 1: Doctor healed themselves AND was the kill target
        // Discord equivalent: if (tag === action.choice && !doc.isAlive)
        if (actorId === targetId && !actor.isAlive) {
          actor.isAlive = true;
          gameState.players.set(actorId, actor);
          gameState.playersAlive.push(actorId);
          gameState.deadThisRound.push({ name: actorId, by: "Doctor" });

          await dm(
            bot,
            actorId,
            `✅ <b>You saved yourself!</b>\n\n` +
              `The Mafia attacked you, but your medical training kept you alive.`,
            path.join(IMAGES_DIR, "health.png"),
          );

          // Case 2: Doctor healed someone else who was the kill target
          // Discord equivalent: else if (doc.isAlive && !target.isAlive && action.choice === killed)
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
            `✅ <b>You saved ${healTarget.username}!</b>\n\n` +
              `The Mafia attacked them, but you arrived just in time.`,
            path.join(IMAGES_DIR, "health.png"),
          );
          await dm(
            bot,
            targetId,
            `💊 <b>The Doctor saved you!</b>\n\n` +
              `The Mafia attacked you last night, but the Doctor arrived ` +
              `just in time to heal you.`,
            path.join(IMAGES_DIR, "health.png"),
          );

          // Case 3: Kill happened but Doctor healed wrong person
          // Discord equivalent: else if (killed) { user.send(unsuccessfulSave) }
        } else if (killedId) {
          const deadPerson = gameState.players.get(killedId);
          const isDocSelf = killedId === actorId; // Doctor was the victim
          await dm(
            bot,
            killedId,
            `💀 <b>${isDocSelf ? "You couldn't grab your first-aid kit in time!" : "The Doctor couldn't reach you!"}</b>\n\n` +
              `You have died. You may spectate the rest of the game, ` +
              `but please don't communicate with living players.`,
            path.join(IMAGES_DIR, "death.png"),
          );
        }

        killedId = null; // Cleared regardless of save outcome
        break;
      }

      // ── MAYOR REVEAL ──────────────────────────────────────────────────
      // Discord equivalent: case "mayor-reveal"
      case "mayor-reveal": {
        const mayorPlayer = gameState.players.get(actorId);
        if (!mayorPlayer.silencedThisRound) {
          // Queue the reveal for announcement at the start of day
          gameState.deadThisRound.push({ name: actorId, by: "Mayor" });
        } else {
          // Silenced — reveal blocked
          // Discord equivalent: the mayorSilencedMessage DM
          gameState.roleState.Mayor.revealed = false; // reset so they can try again
          gameState.mayor = "";
          await dm(
            bot,
            actorId,
            `🤫 <b>You were silenced while trying to reveal yourself!</b>\n\n` +
              `Your mayoral reveal was suppressed. Try again tomorrow night.`,
          );
        }
        break;
      }

      // ── ARSONIST DOUSE ────────────────────────────────────────────────
      // Discord equivalent: case "douse" (original was a bare break — douse happened in prompt)
      case "douse": {
        // Douse was recorded in the prompt layer (collectArsonist added to rs.doused).
        // Nothing to do here in the resolver.
        break;
      }

      // ── ARSONIST IGNITE ───────────────────────────────────────────────
      // Discord equivalent: case "ignite"
      // Bug fixes from original:
      //   1. Jailer check now correctly checks each doused player, not the igniter
      //   2. .doused.filter() used (original had a bracket typo dropping .doused)
      case "ignite": {
        const rs = gameState.roleState.Arsonist;
        const dousedIds = [...rs.doused]; // snapshot before modification
        const burned = [];

        for (const dousedId of dousedIds) {
          const dousedPlayer = gameState.players.get(dousedId);
          if (!dousedPlayer || !dousedPlayer.isAlive) continue;

          // Bug fix: check if EACH doused player is jailed (not the arsonist)
          // Discord original: if (action.choice && Jailer.lastSelection === action.choice)
          //   action.choice was the arsonist's own tag — so this was always false (a bug)
          if (gameState.roleState.Jailer.lastSelection === dousedId) {
            await dm(
              bot,
              actorId,
              `🏠 <b>${dousedPlayer.username}</b> was in jail and escaped the fire!`,
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
            `🔥 <b>Your house burned down while you slept!</b>\n\n` +
              `The Arsonist ignited you. You may spectate but not communicate ` +
              `with living players.`,
          );
        }

        // Bug fix: filter doused list properly
        // Discord original: neutralRoles["Arsonist"].filter(...) — missing .doused
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

      // ── BAITED ───────────────────────────────────────────────────────
      // Discord equivalent: case "baited"
      // The actor visited the Baiter's house and was killed.
      // action.choice === actorId (set in the prompt layer for all roles)
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
          `💥 <b>You were blown up by the Baiter!</b>\n\n` +
            `You visited the wrong house. You may spectate the rest of the game, ` +
            `but please don't communicate with living players.`,
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
