/**
 * gameState.js
 *
 * Singleton module that holds ALL mutable game state.
 * Required by every command and role file — never imported circularly.
 *
 * Discord equivalent: the GameData class in gamedata.js.
 * Key differences:
 *   - Players keyed by numeric Telegram user ID (not username#discriminator string)
 *   - No Discord Guild / Channel / VoiceChannel references
 *   - roleState centralises per-role mutable data (was scattered across GameData)
 *   - Phase gating is done here (not via Discord channel permission overwrites)
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// ROLE STATE FACTORY
// Discord equivalent: per-role properties spread across GameData's mafiaRoles,
// villageRoles, and neutralRoles objects (e.g. gamedata.villageRoles["Doctor"].lastChoice)
// ─────────────────────────────────────────────────────────────────────────────

function initRoleState() {
  return {
    // ── Mafia ─────────────────────────────────────────────────────────────
    Silencer: {
      workedLastNight: false, // alternating-night restriction
      silencedSoFar: [], // user IDs silenced this game (can't repeat)
    },
    Framer: {},
    Godfather: {},
    Mafioso: {},

    // ── Village ───────────────────────────────────────────────────────────
    Doctor: {
      lastChoice: null, // user ID healed last night (can't repeat)
    },
    Detective: {},
    Vigilante: {},
    Mayor: {
      revealed: false,
    },
    Jailer: {
      canJail: true, // alternates each round
      killsLeft: 1, // set to 0 permanently if innocent is executed
      lastSelection: null, // user ID jailed for the coming night
      previousSelection: null, // user ID from the night before
      jailerId: null, // user ID of the Jailer player (set in setup)
    },
    Distractor: {
      workedLastNight: false, // alternating-night restriction
    },
    PI: {},
    Spy: {},

    // ── Neutral ───────────────────────────────────────────────────────────
    Executioner: {
      target: null, // user ID of execution target (set in setup)
      isJester: false, // becomes true if target dies at night
      executionerId: null, // user ID of the Executioner (for win message)
    },
    Jester: {
      jesterId: null, // user ID of the Jester (for win message)
    },
    Baiter: {
      baitedCount: 0, // increments each time an actor visits Baiter
      baiterId: null, // user ID of the Baiter (for win message)
    },
    Arsonist: {
      doused: [], // user IDs who have been doused
      alreadyDead: false, // true if arsonist died this round
      arsonistId: null, // user ID of the Arsonist (for win message)
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMOJI ARRAY
// Discord equivalent: the numbered emoji reactions used for role selection.
// Used in nightPrompts.js and dayVoting.js to label player-selection buttons.
// ─────────────────────────────────────────────────────────────────────────────

const EMOJI_ARRAY = [
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "4️⃣",
  "5️⃣",
  "6️⃣",
  "7️⃣",
  "8️⃣",
  "9️⃣",
  "🔟",
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
];

// ─────────────────────────────────────────────────────────────────────────────
// GODFATHER SUCCESSION ORDER
// Discord equivalent: the isGodfather flag that was set per-role via
// mafiaRoles.updateGodfather(guild). Here we look up centrally.
// ─────────────────────────────────────────────────────────────────────────────

const GF_SUCCESSION = ["Godfather", "Mafioso", "Framer", "Silencer"];

// ─────────────────────────────────────────────────────────────────────────────
// GAME STATE SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

const gameState = {
  // ── Lobby ─────────────────────────────────────────────────────────────────
  /**
   * Map<userId (number), playerObject>
   * Player object shape:
   * {
   *   id:               number,   // Telegram user ID (stable, numeric)
   *   username:         string,   // display label (e.g. "Alice" or "@alice")
   *   displayName:      string,   // full mention form used in DMs
   *   isHost:           boolean,
   *   isAlive:          boolean,
   *   role:             string|null,
   *   align:            string|null,  // "Mafia" | "Village" | "Neutral"
   *   lastWill:         string[],     // array of will lines (renamed from .will)
   *   silencedThisRound:  boolean,    // set by resolver, read at start of dayTime()
   *   silencedLastRound:  boolean,    // set at start of dayTime(), cleared next day
   *   wasFramed:          boolean,    // reset at start of every dayTime()
   *   distracted:         boolean,    // set by resolver, read in resolver next action
   * }
   */
  players: new Map(),
  emojiArray: EMOJI_ARRAY,

  /**
   * Reverse lookup: userId (number) → username string.
   * Discord equivalent: gamedata.userids Map (was string → string).
   */
  userIds: new Map(),

  // ── Phase ─────────────────────────────────────────────────────────────────
  /**
   * "lobby" | "setup" | "night" | "day" | "ended"
   * Discord equivalent: no explicit phase flag — Discord used channel visibility.
   * Here the flag gates middleware and command execution.
   */
  phase: "lobby",

  /**
   * True once /setup has completed. Unlocks /startgame.
   * Discord equivalent: no equivalent — Discord bots started directly.
   */
  gameReady: false,

  /**
   * True during an active game (night or day phase).
   * Used to prevent /join, /leave, /setup, /startgame from running mid-game.
   */
  get isGameActive() {
    return this.phase === "night" || this.phase === "day";
  },

  // ── Round tracking ────────────────────────────────────────────────────────
  currentRound: 0,

  /**
   * Telegram group chat ID where the game is running.
   * Set at /startgame execution.
   * Discord equivalent: implicitly the channel the command was sent in.
   */
  groupChatId: null,

  // ── Alive / dead tracking ─────────────────────────────────────────────────
  /**
   * Array of user IDs who are currently alive.
   * Discord equivalent: gamedata.game.game.playersAlive
   */
  playersAlive: [],

  /**
   * Per-round death/event log. Cleared at the start of each night.
   * Discord equivalent: gamedata.game.game.deadThisRound
   * Shape of each entry: { name: userId, by: string, ...extra }
   */
  deadThisRound: [],

  // ── Role alignment groups ─────────────────────────────────────────────────
  /** Array of user IDs whose align === "Mafia" */
  mafiaPlayers: [],
  /** Array of user IDs whose align === "Village" */
  villagePlayers: [],
  /** Array of user IDs whose align === "Neutral" */
  neutralPlayers: [],

  // ── Mafia team lookup ─────────────────────────────────────────────────────
  /**
   * Maps Mafia role name → userId.
   * Discord equivalent: gamedata.currentMafia Map.
   * Keys: "Godfather", "Mafioso", "Framer", "Silencer"
   */
  currentMafia: {},

  // ── Mayor ─────────────────────────────────────────────────────────────────
  /**
   * User ID of the revealed Mayor, or null.
   * Discord equivalent: gamedata.game.game.mayor
   */
  mayor: null,

  // ── Night action plumbing ─────────────────────────────────────────────────
  /**
   * Map<userId, messageId> — tracks the message_id of each active night prompt
   * so we can disable its inline keyboard on timeout.
   * Discord equivalent: N/A — Discord messages became inert automatically.
   */
  activeNightPrompts: new Map(),

  /**
   * Map used by nightTime() to collect results before passing to resolver.
   * Discord equivalent: let roundByRole = new Map() inside nightActions()
   */
  nightActions: new Map(),

  /**
   * Preserved after each night for the Spy's result delivery.
   * Discord equivalent: roundByRole was in scope for the whole dayTime() call.
   */
  _lastRoundByRole: new Map(),

  // ── Per-role mutable state ────────────────────────────────────────────────
  /** Initialised by initRoleState() at the start of /setup. */
  roleState: initRoleState(),

  // ── Settings ──────────────────────────────────────────────────────────────
  /**
   * Configurable via /settings.
   * Discord equivalent: hardcoded constants in start.js.
   */
  settings: {
    nightTime: 60, // seconds per night phase
    dayTime: 120, // seconds for discussion + nomination vote
    votingTime: 30, // seconds for nominee's defence speech
    mafiaHidden: false, // lowers player threshold for extra Mafia slots
  },

  // ─────────────────────────────────────────────────────────────────────────
  // METHODS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Determine who is currently acting as Godfather.
   * Returns the user ID of the first living Mafia player in succession order.
   * Discord equivalent: mafiaRoles.updateGodfather(guild) which set isGodfather flag.
   *
   * @returns {number|null}
   */
  getActiveGodfather() {
    for (const role of GF_SUCCESSION) {
      const uid = this.currentMafia[role];
      if (uid && this.players.get(uid)?.isAlive) return uid;
    }
    return null;
  },

  /**
   * Hard-reset all game state, preserving the existing player list.
   * Called after game end to prepare the lobby for the next game.
   *
   * Discord equivalent: return ["NEW GAME", players] which triggered
   *   new GameData(playersFromLastRound) — a full constructor re-run.
   *
   * @param {Map} [prevPlayers]  If provided, re-populate players from last game.
   *                              If absent, start with an empty lobby.
   */
  reset(prevPlayers) {
    const settings = { ...this.settings }; // preserve settings across games

    // Re-populate from last game (preserve host/usernames, clear game data)
    if (prevPlayers && prevPlayers.size > 0) {
      this.players = new Map();
      this.userIds = new Map();
      let hostTransferred = false;

      for (const [uid, p] of prevPlayers) {
        const fresh = {
          id: uid,
          username: p.username,
          displayName: p.displayName,
          isHost: p.isHost && !hostTransferred,
          isAlive: true,
          role: null,
          align: null,
          lastWill: [],
          silencedThisRound: false,
          silencedLastRound: false,
          wasFramed: false,
          distracted: false,
        };
        if (p.isHost) hostTransferred = true;
        this.players.set(uid, fresh);
        this.userIds.set(uid, p.username);
      }
    } else {
      this.players = new Map();
      this.userIds = new Map();
    }

    this.phase = "lobby";
    this.gameReady = false;
    this.currentRound = 0;
    this.groupChatId = null;
    this.playersAlive = [];
    this.deadThisRound = [];
    this.mafiaPlayers = [];
    this.villagePlayers = [];
    this.neutralPlayers = [];
    this.currentMafia = {};
    this.mayor = null;
    this.activeNightPrompts = new Map();
    this.nightActions = new Map();
    this._lastRoundByRole = new Map();
    this.roleState = initRoleState();
    this.settings = settings;
  },
};

module.exports = gameState;
