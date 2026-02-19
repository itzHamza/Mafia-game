/**
 * roles/chatPermissions.js
 *
 * Mute / unmute group members using Telegram's restrictChatMember API.
 *
 * Requirements:
 *   - The bot must be a group admin with "Restrict members" permission.
 *   - Bot cannot restrict other admins (Telegram silently ignores those calls).
 *
 * Permission sets used:
 *   MUTED   → can_send_messages: false  (everything off)
 *   UNMUTED → can_send_messages: true   (standard member permissions)
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSION OBJECTS
// ─────────────────────────────────────────────────────────────────────────────

const MUTED = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

const UNMUTED = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Apply permissions to a single user.
 * Errors are swallowed — common causes:
 *   - User is a group admin (Telegram rejects restriction of admins)
 *   - User has left the group
 *   - Bot lost admin rights mid-game
 *
 * @param {Object} bot
 * @param {number} chatId
 * @param {number} userId
 * @param {Object} permissions
 */
async function setPermissions(bot, chatId, userId, permissions) {
  try {
    await bot.telegram.restrictChatMember(chatId, userId, { permissions });
  } catch {
    // Silently ignore — most common case is trying to restrict an admin
  }
}

/**
 * Apply permissions to a list of users with a small delay between calls
 * to avoid hitting Telegram's rate limit (1 restrict/second per chat).
 *
 * @param {Object}   bot
 * @param {number}   chatId
 * @param {number[]} userIds
 * @param {Object}   permissions
 */
async function applyToMany(bot, chatId, userIds, permissions) {
  for (const userId of userIds) {
    await setPermissions(bot, chatId, userId, permissions);
    await sleep(200); // stay under the restrict rate limit
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NIGHT START — mute all players.
 * During night, all communication happens via DM.
 * No player should speak in the group.
 *
 * Called at the start of nightTime().
 *
 * @param {Object} bot
 * @param {number} groupChatId
 * @param {Object} gameState
 */
async function muteAll(bot, groupChatId, gameState) {
  const allIds = Array.from(gameState.players.keys());
  await applyToMany(bot, groupChatId, allIds, MUTED);
}

/**
 * DAY START — update permissions based on current player state.
 *
 * Unmuted  (can speak): alive players who are NOT silenced this round.
 * Kept muted (cannot speak):
 *   - Dead players
 *   - Silenced players (silencedLastRound = true after flag conversion)
 *   - Non-players who happen to be in the group
 *
 * Called at the start of dayTime() AFTER silenced flags are converted.
 *
 * @param {Object} bot
 * @param {number} groupChatId
 * @param {Object} gameState
 */
async function updateDayPermissions(bot, groupChatId, gameState) {
  const toUnmute = [];
  const toMute = [];

  for (const [userId, player] of gameState.players) {
    if (player.isAlive && !player.silencedLastRound) {
      toUnmute.push(userId);
    } else {
      toMute.push(userId);
    }
  }

  // Unmute eligible players first so they can start discussing immediately
  await applyToMany(bot, groupChatId, toUnmute, UNMUTED);
  await applyToMany(bot, groupChatId, toMute, MUTED);
}

/**
 * GAME END — unmute all players.
 * Called after the win message, before the lobby reset.
 *
 * @param {Object} bot
 * @param {number} groupChatId
 * @param {Object} gameState
 */
async function unmuteAll(bot, groupChatId, gameState) {
  const allIds = Array.from(gameState.players.keys());
  await applyToMany(bot, groupChatId, allIds, UNMUTED);
}

module.exports = { muteAll, updateDayPermissions, unmuteAll };
