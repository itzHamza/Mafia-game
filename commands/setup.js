/**
 * commands/setup.js
 * Telegram command: /setup
 * Discord equivalent: m.setup
 *
 * Discord → Telegram replacements:
 *
 *   Channel creation (Town Hall, Godfather's Lair, individual homes)
 *     → DROPPED. Telegram bots cannot create channels/groups.
 *       Replaced by: gameState flags + phase-gating middleware.
 *
 *   Channel permission overwrites per player
 *     → DROPPED. Telegram has no per-user channel ACLs.
 *       Replaced by: gameState.phase + player.silenced* flags
 *                    (enforced in the middleware in bot.js).
 *
 *   new Discord.MessageEmbed().setTitle().setDescription().setImage()
 *     → bot.telegram.sendPhoto(userId, imageStream, { caption: htmlText })
 *       Falls back to sendMessage if image file is missing.
 *
 *   guild.members.fetch(player.id).then(user => user.send(embed))
 *     → bot.telegram.sendPhoto/sendMessage(userId, ...)
 *       ⚠️  Telegram bots can only DM users who have messaged the bot first.
 *           DM failures are caught, reported, and trigger a full rollback.
 *
 *   Godfather's Lair voice channel (mafia team awareness)
 *     → A private DM to each Mafia player listing their teammates.
 *
 *   gamedata.gameActive = true / gamedata.gameReady = true
 *     → gameState.phase = 'setup' / gameState.gameReady = true
 *
 * Bugs fixed from original:
 *   None specific to setup.js, but the createVillage() return value / gameReady
 *   assignment was confusing (always evaluated to true). Replaced with explicit
 *   success/failure flow and rollback on DM failure.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const { ROLES, MAFIA_TIERS, VILLAGE_TIERS, NEUTRAL_TIERS, ALIGN_EMOJI } =
    require("../roles/roleData");

const IMAGES_DIR = path.join(__dirname, "..", "images");

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

// ─────────────────────────────────────────────────────────────────────────────
// TIER-WALKING ROLE PICKER
// Direct port of the role assignment loop body from createVillage() in setup.js.
//
// Operates on a deep-cloned tier object (mutated in place) and a state object
// holding currentTier + rolePool references.
//
// pick: false → "exhaust" mode: remove picked role; advance tier when tier is empty.
// pick: N     → "quota" mode:  remove picked role; decrement pick; advance when pick=0.
// no tier left → fall back to pool.
//
// Discord equivalent: the if/else-if/else block inside each assignment for loop.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} tiersClone  Deep clone of a TIERS constant (mutated).
 * @param {{ currentTier: number, rolePool: string[] }} state  Mutated in place.
 * @returns {string} The chosen role name.
 */
function pickRole(tiersClone, state) {
    const tier = tiersClone[state.currentTier];

    let roleName;

    if (!tier) {
        // ── All tiers exhausted: pick from the overflow pool ─────────────────
        // Discord equivalent: if (!currentTierObject[currentTier])
        roleName = state.rolePool[Math.floor(Math.random() * state.rolePool.length)];

    } else if (!tier.pick) {
        // ── Exhaust mode: pick any remaining role from tier, advance when empty ──
        // Discord equivalent: else if (!currentTierObject[currentTier].pick)
        // Note: !false === true, so pick:false triggers this branch.
        roleName = tier.roles[Math.floor(Math.random() * tier.roles.length)];
        tier.roles = tier.roles.filter(r => r !== roleName);
        if (tier.roles.length === 0) state.currentTier++;

    } else {
        // ── Quota mode: pick one, decrement quota, advance when quota reaches 0 ──
        // Discord equivalent: else { ... currentTierObject[currentTier].pick-- ... }
        roleName = tier.roles[Math.floor(Math.random() * tier.roles.length)];
        tier.roles = tier.roles.filter(r => r !== roleName);
        tier.pick--;
        if (!tier.pick) state.currentTier++;
    }

    // Remove chosen role from the pool so it can't appear as a fallback later
    state.rolePool = state.rolePool.filter(r => r !== roleName);
    return roleName;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE CARD FORMATTER
// Discord equivalent: new Discord.MessageEmbed()
//   .setColor(...)
//   .setTitle(`You are the **${role}**`)
//   .setDescription(description)
//   .addField("Goal", goal)
//   .attachFiles([`images/${role}.png`])
//   .setImage(...)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a role card as an HTML string for use as a photo caption or message.
 * Telegram captions are capped at 1024 characters; if the card is longer
 * the caller should split it into caption + follow-up message.
 *
 * @param {string} roleName
 * @param {Object} roleInfo  Entry from ROLES constant.
 * @returns {string} HTML-formatted role card.
 */
function formatRoleCard(roleName, roleInfo) {
    const emoji = ALIGN_EMOJI[roleInfo.align] ?? "⚪";
    return (
        `🎭 <b>You are the ${roleName.toUpperCase()}</b>\n\n` +
        `${emoji} <b>Alignment:</b> ${roleInfo.align}\n\n` +
        `📖 <i>${roleInfo.description}</i>\n\n` +
        `🎯 <b>Goal:</b> ${roleInfo.goal}`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// DM SENDERS
// Discord equivalent: guild.members.fetch(id).then(user => user.send(embed))
// Key difference: Telegram bots cannot DM users who haven't messaged them first.
// All senders return { success: boolean, error?: string } — never throw.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a role card (image + caption, or text fallback) to a player's DM.
 *
 * @param {Object} bot       Telegraf bot instance.
 * @param {number} userId    Telegram user ID.
 * @param {string} roleName
 * @param {Object} roleInfo  Entry from ROLES constant.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendRoleCard(bot, userId, roleName, roleInfo) {
    const cardText = formatRoleCard(roleName, roleInfo);
    const imagePath = path.join(IMAGES_DIR, roleInfo.image);
    const imageExists = fs.existsSync(imagePath);

    try {
        if (imageExists) {
            // Telegram photo captions cap at 1024 chars.
            // If our card fits, send as caption; otherwise send photo then text.
            if (cardText.length <= 1024) {
                await bot.telegram.sendPhoto(
                    userId,
                    { source: fs.createReadStream(imagePath) },
                    { caption: cardText, parse_mode: "HTML" }
                );
            } else {
                // Photo first (no caption), then the full text as a follow-up
                await bot.telegram.sendPhoto(
                    userId,
                    { source: fs.createReadStream(imagePath) }
                );
                await bot.telegram.sendMessage(userId, cardText, {
                    parse_mode: "HTML",
                });
            }
        } else {
            // Fallback: image file not found, send text only
            console.warn(`⚠️  Image not found: ${imagePath}`);
            await bot.telegram.sendMessage(userId, cardText, {
                parse_mode: "HTML",
            });
        }
        return { success: true };
    } catch (err) {
        // Most common cause: the player has never messaged the bot
        // (Telegram requires users to initiate contact first).
        return { success: false, error: err.message };
    }
}

/**
 * Send the Mafia team roster to a single Mafia player.
 * Discord equivalent: awareness from sharing the Godfather's Lair voice channel.
 * In Telegram: a DM listing each teammate's name and role.
 *
 * @param {Object} bot
 * @param {number} userId       The recipient Mafia player's user ID.
 * @param {number[]} mafiaIds   All Mafia player user IDs (including recipient).
 * @param {Map<number,Object>} players  gameState.players
 */
async function sendMafiaTeamDM(bot, userId, mafiaIds, players) {
    const teammates = mafiaIds
        .filter(id => id !== userId)
        .map(id => {
            const p = players.get(id);
            return `• <b>${p.username}</b> — ${p.role}`;
        });

    const msg = teammates.length > 0
        ? `🔴 <b>Your Mafia teammates:</b>\n${teammates.join("\n")}\n\n` +
          `Coordinate via DM with each other, or create a private group chat.`
        : `🔴 <b>You are the sole Mafia member</b> this game. Good luck!`;

    // Suppress secondary errors — the primary sendRoleCard already reported failure
    await bot.telegram.sendMessage(userId, msg, { parse_mode: "HTML" }).catch(() => {});
}

/**
 * Send the Executioner their target assignment.
 * Discord equivalent: user.send(player.execMessage) in setup.js.
 *
 * @param {Object} bot
 * @param {number} userId         Executioner's user ID.
 * @param {number} targetId       Target's user ID.
 * @param {Map<number,Object>} players
 */
async function sendExecutionerTargetDM(bot, userId, targetId, players) {
    const target = players.get(targetId);
    if (!target) return;

    const imagePath = path.join(IMAGES_DIR, "death.png");
    const msg =
        `🎯 <b>Your target is ${target.username}.</b>\n\n` +
        `Your goal is to get them <b>lynched</b> by the town.\n\n` +
        `If they die during the <i>night</i> instead, you will automatically ` +
        `become the <b>Jester</b> — and your new goal will be to get ` +
        `<b>yourself</b> lynched.`;

    try {
        if (fs.existsSync(imagePath)) {
            await bot.telegram.sendPhoto(
                userId,
                { source: fs.createReadStream(imagePath) },
                { caption: msg, parse_mode: "HTML" }
            );
        } else {
            await bot.telegram.sendMessage(userId, msg, { parse_mode: "HTML" });
        }
    } catch {
        // Suppressed — parent handler already caught the DM failure
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLLBACK HELPER
// Discord equivalent: N/A — the original had no rollback mechanism.
// We need this because a partial setup (some DMs sent, some failed) would leave
// the game in an unfair state.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Undo all role assignments and reset game flags after a failed setup.
 * Called when one or more players couldn't receive their role DM.
 *
 * @param {Object} gameState
 */
function rollbackSetup(gameState) {
    for (const [, player] of gameState.players) {
        player.role  = undefined;
        player.align = undefined;
    }
    gameState.phase         = "lobby";
    gameState.gameReady     = false;
    gameState.playersAlive  = [];
    gameState.mafiaPlayers  = [];
    gameState.villagePlayers = [];
    gameState.neutralPlayers = [];
    gameState.currentMafia  = {
        Godfather: null, Mafioso: null, Framer: null, Silencer: null,
    };

    // Re-initialise roleState by requiring the factory function.
    // We can't call initRoleState() directly here (it's module-private to gameState.js),
    // so we reset individual fields instead.
    const rs = gameState.roleState;
    rs.Silencer.workedLastNight = false;
    rs.Silencer.silencedSoFar   = [];
    rs.Silencer.silencerId      = null;
    rs.Doctor.lastChoice        = null;
    rs.Doctor.doctorId          = null;
    rs.Jailer.canJail           = true;
    rs.Jailer.killsLeft         = 3;
    rs.Jailer.lastSelection     = null;
    rs.Jailer.previousSelection = null;
    rs.Jailer.jailerId          = null;
    rs.Distractor.workedLastNight = false;
    rs.Distractor.distractorId  = null;
    rs.Mayor.revealed            = false;
    rs.Mayor.mayorId             = null;
    rs.Executioner.target        = null;
    rs.Executioner.isJester      = false;
    rs.Executioner.executionerId = null;
    rs.Baiter.baitedCount        = 0;
    rs.Baiter.baiterId           = null;
    rs.Arsonist.doused           = [];
    rs.Arsonist.alreadyDead      = false;
    rs.Arsonist.arsonistId       = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    name: "setup",
    description: "Set up a new game by assigning roles to all players in the lobby.",

    async execute(ctx, args, gameState, bot) {

        // ── Guard: group chat only ────────────────────────────────────────────
        if (ctx.chat.type === "private") {
            return ctx.reply("⚠️ This command must be used in the group chat.");
        }

        // ── Guard: minimum player count ───────────────────────────────────────
        // Discord equivalent: if (gamedata.players.size < 5)
        if (gameState.players.size < 5) {
            return ctx.reply(
                `⚠️ Not enough players! You need at least <b>5</b> to play.\n` +
                `Current party: <b>${gameState.players.size}</b> player(s).`,
                { parse_mode: "HTML" }
            );
        }

        // ── Guard: setup not already running or complete ───────────────────────
        // Discord equivalent: if (gamedata.gameActive)
        if (gameState.phase === "setup") {
            return ctx.reply("⏳ Setup is already in progress, please wait.");
        }
        if (gameState.gameReady || gameState.isGameActive) {
            return ctx.reply(
                "⚠️ The game is already set up. Use /startgame to begin,\n" +
                "or /66 to reset and start over."
            );
        }

        // ── Guard: host or admin only ─────────────────────────────────────────
        // Discord equivalent:
        //   if (!gamedata.players.get(message.author.tag).isHost
        //     && message.author.tag !== "PiAreSquared#6784" ...)
        const issuerId = ctx.from.id;
        const issuer   = gameState.players.get(issuerId);
        const isAuthorized =
            (issuer && issuer.isHost) || ADMIN_IDS.includes(issuerId);

        if (!isAuthorized) {
            return ctx.reply(
                `⚠️ Only the 👑 <b>Host</b> can run /setup.`,
                { parse_mode: "HTML" }
            );
        }

        // ── Lock game state to prevent re-entry ───────────────────────────────
        // Discord equivalent: gamedata.gameActive = true (set at top of createVillage)
        gameState.phase = "setup";

        await ctx.reply(
            `⚙️ <b>Setting up Mafiaville for ${gameState.players.size} players…</b>\n\n` +
            `Each player will receive their role via 📨 <b>private message</b>.\n\n` +
            `⚠️ <b>Important:</b> If you haven't messaged me privately before, ` +
            `please tap my profile and press <b>Start</b> right now — ` +
            `otherwise I can't send you your role!`,
            { parse_mode: "HTML" }
        );

        // ─────────────────────────────────────────────────────────────────────
        // STEP 1 — CALCULATE GROUP SIZES
        // Discord equivalent: the mafiaCount / neutralCount block in createVillage()
        //
        // Operator precedence preserved exactly from original:
        //   (mafiaHidden && size >= 10) || size >= 13   → 3 mafia
        //   (mafiaHidden && size >= 6)  || size >= 8    → 2 mafia
        //   default                                      → 1 mafia, 1 neutral
        // ─────────────────────────────────────────────────────────────────────

        const playerCount  = gameState.players.size;
        const mafiaHidden  = gameState.settings.mafiaHidden;

        let mafiaCount, neutralCount;

        if ((mafiaHidden && playerCount >= 10) || playerCount >= 13) {
            mafiaCount   = 3;
            neutralCount = Math.round(Math.random()) + 2;
            if (playerCount > 11) neutralCount++;
        } else if ((mafiaHidden && playerCount >= 6) || playerCount >= 8) {
            mafiaCount   = 2;
            neutralCount = Math.round(Math.random());
            if (playerCount > 7) neutralCount++;
        } else {
            mafiaCount   = 1;
            neutralCount = 1;
        }

        const villagerCount = playerCount - mafiaCount - neutralCount;

        // ─────────────────────────────────────────────────────────────────────
        // STEP 2 — BUILD PLAYER POOL
        // Discord equivalent:
        //   let playersList = Array.from(gamedata.players.keys())
        //   gamedata.game.game.playersAlive = playersList
        //   (selection: playersList[Math.floor(Math.random() * playersList.length)])
        //   (removal:   playersList = playersList.filter(v => v !== randPlayer))
        // ─────────────────────────────────────────────────────────────────────

        // playersAlive stores numeric user IDs (Discord stored string tags)
        gameState.playersAlive = Array.from(gameState.players.keys());

        // Mutable pool — splice replaces the filter+reassign pattern from original
        const playerPool = Array.from(gameState.players.keys());

        /**
         * Remove and return a random user ID from the pool.
         * Discord equivalent:
         *   var randPlayer = playersList[Math.floor(Math.random() * playersList.length)];
         *   playersList = playersList.filter(v => v !== randPlayer);
         */
        function drawPlayer() {
            const idx = Math.floor(Math.random() * playerPool.length);
            const [id] = playerPool.splice(idx, 1);
            return id;
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 3 — ASSIGN MAFIA ROLES
        // Discord equivalent: the mafia for loop in createVillage()
        // ─────────────────────────────────────────────────────────────────────

        const mafiaState = {
            currentTier: 1,
            rolePool: [...MAFIA_TIERS.pool],
        };
        const mafiaClone = JSON.parse(JSON.stringify(MAFIA_TIERS));

        for (let i = 0; i < mafiaCount; i++) {
            const userId   = drawPlayer();
            const roleName = pickRole(mafiaClone, mafiaState);
            const player   = gameState.players.get(userId);

            player.role  = roleName;
            player.align = "Mafia";

            // Discord equivalent: gamedata.mafiaRoles.currentMafia[player.role] = randPlayer
            if (Object.prototype.hasOwnProperty.call(gameState.currentMafia, roleName)) {
                gameState.currentMafia[roleName] = userId;
            }
            gameState.mafiaPlayers.push(userId);
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 4 — ASSIGN VILLAGE ROLES
        // Discord equivalent: the village for loop in createVillage()
        // ─────────────────────────────────────────────────────────────────────

        const villageState = {
            currentTier: 1,
            rolePool: [...VILLAGE_TIERS.pool],
        };
        const villageClone = JSON.parse(JSON.stringify(VILLAGE_TIERS));

        for (let i = 0; i < villagerCount; i++) {
            const userId   = drawPlayer();
            const roleName = pickRole(villageClone, villageState);
            const player   = gameState.players.get(userId);

            player.role  = roleName;
            player.align = "Village";

            gameState.villagePlayers.push(userId);
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 5 — ASSIGN NEUTRAL ROLES
        // Discord equivalent: the neutral for loop in createVillage()
        // ─────────────────────────────────────────────────────────────────────

        const neutralState = {
            currentTier: 1,
            rolePool: [...NEUTRAL_TIERS.pool],
        };
        const neutralClone = JSON.parse(JSON.stringify(NEUTRAL_TIERS));

        for (let i = 0; i < neutralCount; i++) {
            const userId   = drawPlayer();
            const roleName = pickRole(neutralClone, neutralState);
            const player   = gameState.players.get(userId);

            player.role  = roleName;
            player.align = "Neutral";

            gameState.neutralPlayers.push(userId);

            // ── Executioner: pick a random non-Mayor village target ───────────
            // Discord equivalent:
            //   let villageRolesFiltered = gamedata.villageRoles.players
            //     .filter(t => gamedata.players.get(t).role !== "Mayor");
            //   let target = villageRolesFiltered[Math.floor(...)]
            //   gamedata.neutralRoles["Executioner"].target = target;
            if (roleName === "Executioner") {
                const eligibleTargets = gameState.villagePlayers.filter(
                    id => gameState.players.get(id)?.role !== "Mayor"
                );
                if (eligibleTargets.length > 0) {
                    const targetId = eligibleTargets[
                        Math.floor(Math.random() * eligibleTargets.length)
                    ];
                    gameState.roleState.Executioner.target        = targetId;
                    gameState.roleState.Executioner.executionerId = userId;
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 6 — POPULATE ROLE STATE IDs
        // Record which player holds each stateful role so Phase 4 handlers
        // can look them up without scanning the entire players map.
        // Discord equivalent: implicit — role objects were singletons on GameData.
        // ─────────────────────────────────────────────────────────────────────

        const rs = gameState.roleState;

        for (const [userId, player] of gameState.players) {
            switch (player.role) {
                case "Godfather":  rs.Godfather.godfatherId   = userId; break;
                case "Mafioso":    rs.Mafioso.mafiosoId       = userId; break;
                case "Framer":     rs.Framer.framerId          = userId; break;
                case "Silencer":   rs.Silencer.silencerId      = userId; break;
                case "Doctor":     rs.Doctor.doctorId          = userId; break;
                case "Detective":  rs.Detective.detectiveId    = userId; break;
                case "Vigilante":  rs.Vigilante.vigilanteId    = userId; break;
                case "Mayor":      rs.Mayor.mayorId             = userId; break;
                case "Jailer":     rs.Jailer.jailerId          = userId; break;
                case "Distractor": rs.Distractor.distractorId  = userId; break;
                case "PI":         rs.PI.piId                  = userId; break;
                case "Spy":        rs.Spy.spyId                = userId; break;
                case "Jester":     rs.Jester.jesterId          = userId; break;
                case "Baiter":     rs.Baiter.baiterId          = userId; break;
                case "Arsonist":   rs.Arsonist.arsonistId      = userId; break;
                // Executioner id already set in Step 5
                default: break;
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 7 — SEND ROLE DMs CONCURRENTLY
        // Discord equivalent:
        //   for (const [tag, player] of gamedata.players)
        //     guild.members.fetch(player.id).then(user => user.send(player.roleMessage))
        //
        // All DMs are fired in parallel (Promise.all) then failures are evaluated.
        // If ANY player can't be DMed, we roll back the entire setup so no one
        // has an unfair information advantage.
        // ─────────────────────────────────────────────────────────────────────

        const dmResults = await Promise.all(
            Array.from(gameState.players.entries()).map(async ([userId, player]) => {
                const roleInfo = ROLES[player.role];
                if (!roleInfo) {
                    return { userId, username: player.username, success: false,
                             error: `No role data found for role: ${player.role}` };
                }

                // ── Send role card ────────────────────────────────────────────
                const result = await sendRoleCard(bot, userId, player.role, roleInfo);
                if (!result.success) {
                    return { userId, username: player.username, ...result };
                }

                // ── Send Mafia team roster ────────────────────────────────────
                // Discord equivalent: seeing teammates in Godfather's Lair voice channel
                if (player.align === "Mafia") {
                    await sendMafiaTeamDM(
                        bot, userId, gameState.mafiaPlayers, gameState.players
                    );
                }

                // ── Send Executioner target ───────────────────────────────────
                // Discord equivalent: user.send(player.execMessage)
                if (player.role === "Executioner" && rs.Executioner.target) {
                    await sendExecutionerTargetDM(
                        bot, userId, rs.Executioner.target, gameState.players
                    );
                }

                return { userId, username: player.username, success: true };
            })
        );

        // ─────────────────────────────────────────────────────────────────────
        // STEP 8 — HANDLE DM FAILURES
        // ─────────────────────────────────────────────────────────────────────

        const failures = dmResults.filter(r => !r.success);

        if (failures.length > 0) {
            const failList = failures
                .map(r => `• ${r.username}`)
                .join("\n");

            // Roll back all role assignments so the game can be re-setup fairly
            rollbackSetup(gameState);

            await ctx.reply(
                `❌ <b>Setup failed!</b>\n\n` +
                `The following player(s) couldn't receive their role via DM:\n` +
                `${failList}\n\n` +
                `<b>What to do:</b>\n` +
                `1. Have each listed player tap on my username\n` +
                `2. Press <b>Start</b> to open a private chat with me\n` +
                `3. The host can then run /setup again.\n\n` +
                `All role assignments have been cleared.`,
                { parse_mode: "HTML" }
            );
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 9 — FINALISE STATE & POST GROUP SUMMARY
        // Discord equivalent: gamedata.gameReady = true (set in channel creation callback)
        // We also post a summary that replaces the visual of seeing new channels appear.
        // ─────────────────────────────────────────────────────────────────────

        // gameReady = true unlocks /startgame
        // phase returns to 'lobby' — it moves to 'night' when /startgame is called
        gameState.gameReady = true;
        gameState.phase     = "lobby";

        // Role count summary (doesn't reveal which player has which role)
        const alignBreakdown =
            `🔴 Mafia: <b>${mafiaCount}</b>\n` +
            `🟢 Village: <b>${villagerCount}</b>\n` +
            `🔵 Neutral: <b>${neutralCount}</b>`;

        await ctx.reply(
            `✅ <b>Mafiaville is ready!</b>\n\n` +
            `👥 <b>${playerCount} players</b> have been assigned roles:\n` +
            `${alignBreakdown}\n\n` +
            `📨 Everyone has received their role via private message.\n` +
            `Read your role card carefully before the game begins!\n\n` +
            `When you're ready, the 👑 host can use /startgame.`,
            { parse_mode: "HTML" }
        );
    },
};