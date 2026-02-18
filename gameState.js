/**
 * gameState.js
 * Singleton in-memory game state for the Mafiaville Telegram Mafia Bot.
 *
 * All game data lives here. No database is used.
 * Import this module anywhere with: const gameState = require('./gameState');
 */

"use strict";

/**
 * @typedef {Object} Player
 * @property {number}   id               - Telegram user ID (used as the primary key)
 * @property {string}   username         - Telegram display name (first_name or username)
 * @property {string|undefined} role     - Assigned role, e.g. 'Godfather', 'Detective'
 * @property {string|undefined} align    - 'Mafia' | 'Village' | 'Neutral'
 * @property {boolean}  isAlive          - Whether the player is still in the game
 * @property {boolean}  isHost           - Whether this player created the lobby
 * @property {string[]} lastWill         - Lines of the player's last will
 * @property {boolean}  distracted       - Blocked from acting this night (Distractor effect)
 * @property {boolean}  wasFramed        - Appears as Mafia to Detective this night (Framer effect)
 * @property {boolean}  silencedThisRound  - Cannot speak in group chat this day
 * @property {boolean}  silencedLastRound  - Was silenced last round (for unsilence logic)
 * @property {string|undefined} roleMessage - Formatted string sent to player at game start
 */

/**
 * @typedef {'lobby'|'night'|'day'|'ended'} GamePhase
 */

const gameState = {
  // -------------------------------------------------------------------------
  // LOBBY & PLAYER TRACKING
  // -------------------------------------------------------------------------

  /**
   * Map of Telegram user ID (number) → Player object.
   * This is the single source of truth for all player data.
   * @type {Map<number, Player>}
   */
  players: new Map(),

  /**
   * Reverse lookup: Telegram user ID → username string.
   * Mirrors Discord's gamedata.userids for compat with ported logic.
   * @type {Map<number, string>}
   */
  userIds: new Map(),

  // -------------------------------------------------------------------------
  // GAME IDENTITY
  // -------------------------------------------------------------------------

  /**
   * Telegram user ID of the game host (the player who used /join first).
   * @type {number|null}
   */
  host: null,

  /**
   * The Telegram group chat ID where the game is being run.
   * Set when the first command is issued in a group.
   * @type {number|null}
   */
  groupChatId: null,

  // -------------------------------------------------------------------------
  // GAME PHASE
  // -------------------------------------------------------------------------

  /**
   * Current phase of the game.
   * @type {GamePhase}
   */
  phase: "lobby",

  /**
   * Current round number (increments each night→day cycle).
   * @type {number}
   */
  currentRound: 0,

  // -------------------------------------------------------------------------
  // ALIVE PLAYERS & DEATH LOG
  // -------------------------------------------------------------------------

  /**
   * List of usernames still alive, in insertion order.
   * Mirrors Discord's game.game.playersAlive array.
   * @type {string[]}
   */
  playersAlive: [],

  /**
   * Deaths that occurred this round, resolved at the start of the day phase.
   * Each entry: { name: username, by: 'Mafia'|'Vigilante'|'Doctor'|... }
   * @type {Array<{name: string, by: string, [key: string]: any}>}
   */
  deadThisRound: [],

  // -------------------------------------------------------------------------
  // VOTING (DAY PHASE)
  // -------------------------------------------------------------------------

  /**
   * Maps voter's Telegram user ID → the username of who they nominated.
   * Cleared at the start of each day phase.
   * @type {Map<number, string>}
   */
  votes: new Map(),

  /**
   * The player currently nominated for execution (during the defense window).
   * @type {string|null}
   */
  nominee: null,

  /**
   * The Telegram message ID of the active voting inline keyboard prompt.
   * Used to edit or delete the prompt when voting ends.
   * @type {number|null}
   */
  activeVoteMessageId: null,

  // -------------------------------------------------------------------------
  // NIGHT ACTIONS
  // -------------------------------------------------------------------------

  /**
   * Maps acting player's Telegram user ID → their chosen action object for this night.
   * Format mirrors Discord: { action: 'kill' | 'heal' | 'check' | ..., choice: username }
   * Cleared at the start of each night phase.
   * @type {Map<number, {action: string, choice: string|string[]}>}
   */
  nightActions: new Map(),

  /**
   * Tracks active night-action inline keyboard message IDs (one per player DM).
   * Maps Telegram user ID → message ID, so we can edit/delete prompts on timeout.
   * @type {Map<number, number>}
   */
  activeNightPrompts: new Map(),

  // -------------------------------------------------------------------------
  // MAYOR STATE
  // -------------------------------------------------------------------------

  /**
   * Telegram user ID of the revealed Mayor (grants double vote).
   * Empty string if Mayor has not revealed yet (matches Discord original).
   * @type {number|string}
   */
  mayor: "",

  // -------------------------------------------------------------------------
  // SETTINGS
  // -------------------------------------------------------------------------

  /**
   * Configurable time limits (seconds) for each phase.
   * These match the original Discord bot's defaults.
   */
  settings: {
    nightTime: 30,
    dayTime: 40,
    votingTime: 20,
  },

  // -------------------------------------------------------------------------
  // EMOJI ARRAY (for numbered reaction-style inline buttons)
  // -------------------------------------------------------------------------

  /**
   * Letter emojis used as selectors in inline keyboards.
   * Replaces Discord's reaction-based selection system.
   * @type {string[]}
   */
  emojiArray: [
    "🇦",
    "🇧",
    "🇨",
    "🇩",
    "🇪",
    "🇫",
    "🇬",
    "🇭",
    "🇮",
    "🇯",
    "🇰",
    "🇱",
    "🇲",
    "🇳",
    "🇴",
    "🇵",
    "🇶",
    "🇷",
    "🇸",
    "🇹",
    "🇺",
    "🇻",
    "🇼",
    "🇽",
    "🇾",
    "🇿",
  ],

  // -------------------------------------------------------------------------
  // ROLE LISTS
  // -------------------------------------------------------------------------

  allRoles: [
    "Godfather",
    "Mafioso",
    "Framer",
    "Silencer",
    "Detective",
    "Doctor",
    "Vigilante",
    "Mayor",
    "Distractor",
    "PI",
    "Spy",
    "Jester",
    "Executioner",
    "Baiter",
    "Arsonist",
  ],

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Fully resets game state to a clean lobby, optionally preserving
   * the player list (for post-game re-lobby, matching Discord's NEW GAME logic).
   * @param {Map<number, Player>|null} playersFromLastRound
   */
  reset(playersFromLastRound = null) {
    this.players = playersFromLastRound ?? new Map();
    this.userIds = new Map();
    this.host = null;
    this.phase = "lobby";
    this.currentRound = 0;
    this.playersAlive = [];
    this.deadThisRound = [];
    this.votes = new Map();
    this.nominee = null;
    this.activeVoteMessageId = null;
    this.nightActions = new Map();
    this.activeNightPrompts = new Map();
    this.mayor = "";

    // Re-populate userIds from carried-over players
    if (playersFromLastRound) {
      for (const [id, player] of playersFromLastRound) {
        this.userIds.set(id, player.username);
      }
    }
  },

  /**
   * Returns true if the game is currently in an active (non-lobby, non-ended) phase.
   * @returns {boolean}
   */
  get isGameActive() {
    return this.phase !== "lobby" && this.phase !== "ended";
  },

  /**
   * Convenience: get a player by Telegram user ID.
   * @param {number} userId
   * @returns {Player|undefined}
   */
  getPlayer(userId) {
    return this.players.get(userId);
  },

  /**
   * Convenience: get all alive players as an array of Player objects.
   * @returns {Player[]}
   */
  getAlivePlayers() {
    return Array.from(this.players.values()).filter((p) => p.isAlive);
  },

  /**
   * Convenience: get the Telegram user ID for a given username.
   * Reverse lookup via userIds map.
   * @param {string} username
   * @returns {number|undefined}
   */
  getIdByUsername(username) {
    for (const [id, name] of this.userIds) {
      if (name === username) return id;
    }
    return undefined;
  },
};

module.exports = gameState;
