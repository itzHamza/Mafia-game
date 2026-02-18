/**
 * roles/roleData.js
 * Static role data extracted from the original Discord bot's GameData class.
 *
 * Discord equivalent: the inline role objects inside mafiaRoles, villageRoles,
 * and neutralRoles in bot.js (descriptions, goals, alignments, tier configs).
 *
 * Night action logic (prompt(), night() functions) is NOT here — that's Phase 4.
 * This file is pure data: no Discord.js imports, no bot references.
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// ROLE DEFINITIONS
// Each entry mirrors the original role object's static fields.
// Dynamic per-game state (workedLastNight, lastChoice, etc.) lives in gameState.roleState.
// ─────────────────────────────────────────────────────────────────────────────

const ROLES = {
  // ── MAFIA ─────────────────────────────────────────────────────────────────

  Godfather: {
    align: "Mafia",
    description:
      "You're the leader of the Mafiaville Mafia and order a murder each night. " +
      "Your goal is to have all the townspeople killed.",
    goal: "Kill the villagers. You win when the number of villagers equals or falls below the number of Mafia.",
    image: "godfather.png",
    isLeader: true, // used in Phase 4 to determine who sends the kill prompt
  },
  Mafioso: {
    align: "Mafia",
    description:
      "You're the Godfather's right-hand man. As long as the Godfather is alive, " +
      "you'll do exclusively his bidding. However, if he meets his demise, you'll replace him.",
    goal: "Help the Godfather kill the villagers. You win when the number of villagers equals or falls below the number of Mafia.",
    image: "mafioso.png",
    isLeader: false,
  },
  Framer: {
    align: "Mafia",
    description:
      "You've moved up the ranks in the Mafiaville Mafia due to your uncanny ability to alter " +
      "the evidence. Frame innocent villagers each night so the Detective gets the wrong result.",
    goal: "Help the Godfather kill the villagers. You win when the number of villagers equals or falls below the number of Mafia.",
    image: "framer.png",
    isLeader: false,
  },
  Silencer: {
    align: "Mafia",
    description:
      "You go after innocent villagers — but instead of killing them, you silence them, " +
      "preventing them from participating in the next Town Hall meeting. " +
      "You can only silence every other night.",
    goal: "Help the Godfather kill the villagers. You win when the number of villagers equals or falls below the number of Mafia.",
    image: "silencer.png",
    isLeader: false,
  },

  // ── VILLAGE ───────────────────────────────────────────────────────────────

  Doctor: {
    align: "Village",
    description:
      "You're the resident medical expert in Mafiaville. " +
      "Each night you can protect one player from the Mafia's attack. " +
      "You cannot protect the same person two nights in a row.",
    goal: "Help the village eliminate all the Mafia.",
    image: "doctor.png",
  },
  Detective: {
    align: "Village",
    description:
      "As the criminology expert in the Mafiaville Police Department, " +
      "you investigate one player each night to determine if they are in the Mafia. " +
      "Note: the Framer can make innocents look guilty.",
    goal: "Help the village eliminate all the Mafia.",
    image: "detective.png",
  },
  Vigilante: {
    align: "Village",
    description:
      "Having little faith in the MPD, you've chosen to take matters into your own hands. " +
      "You can shoot a player each night — but if you kill an innocent villager, " +
      "you will take your own life out of guilt.",
    goal: "Help the village eliminate all the Mafia.",
    image: "vigilante.png",
  },
  Mayor: {
    align: "Village",
    description:
      "You've been elected as the leader of the Mafiaville City Council! " +
      "You can choose to reveal yourself during the night, granting you an extra vote " +
      "at Town Hall — but once revealed, the Mafia will target you.",
    goal: "Help the village eliminate all the Mafia.",
    image: "mayor.png",
  },
  Jailer: {
    align: "Village",
    description:
      "Every other night, you can jail a townsperson overnight — blocking their action " +
      "and protecting them from attacks. You can also choose to execute your prisoner, " +
      "but if you execute a villager you permanently lose the ability to execute.",
    goal: "Help the village eliminate all the Mafia.",
    image: "jailer.png",
  },
  Distractor: {
    align: "Village",
    description:
      "You're naturally very intimidating. When you visit someone's house, " +
      "they forget their plans for the night and hide in their bedroom. " +
      "You can only distract every other night.",
    goal: "Help the village eliminate all the Mafia.",
    image: "distractor.png",
  },
  PI: {
    align: "Village",
    description:
      "You're a social psychologist who can determine if two players are on the same side — " +
      "but you won't know which side that is. Choose two players each night to compare.",
    goal: "Help the village eliminate all the Mafia.",
    image: "pi.png",
  },
  Spy: {
    align: "Village",
    description:
      "You follow one player all night and find out who, if anyone, they visited. " +
      "You won't know why they visited, but the implications may be clear.",
    goal: "Help the village eliminate all the Mafia.",
    image: "spy.png",
  },

  // ── NEUTRAL ───────────────────────────────────────────────────────────────

  Executioner: {
    align: "Neutral",
    description:
      "You want one specific villager lynched by the town. " +
      "If they die during the night instead, you become the Jester — " +
      "and your new goal is to get yourself lynched.",
    goal: "Get your target lynched at a Town Hall vote.",
    image: "executioner.png",
  },
  Jester: {
    align: "Neutral",
    description:
      "All your life people have laughed at you. Now it's time for the ultimate prank: " +
      "get YOURSELF lynched by the town. If you die any other way, you've failed.",
    goal: "Get yourself lynched at a Town Hall vote.",
    image: "jester.png",
  },
  Baiter: {
    align: "Neutral",
    description:
      "An angry, wheelchair-bound army veteran, you've rigged your house with explosives. " +
      "Anyone who visits you at night will be blown up. " +
      "Bait three people and survive to the end of the game.",
    goal: "Bait three players and survive to the end.",
    image: "baiter.png",
  },
  Arsonist: {
    align: "Neutral",
    description:
      "Like Nero fiddled over burning Rome, you play the flute over Mafiaville in flames. " +
      "Each night you can douse a player in petrol. When you choose to ignite, " +
      "all doused players burn simultaneously.",
    goal: "Kill everyone — be the last one standing.",
    image: "arsonist.png",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TIER CONFIGURATIONS
// Direct port of the tier objects from GameData in bot.js.
//
// pick: false → exhaust every role in the tier before moving to the next
// pick: N     → pick exactly N roles from this tier, then move on
//               (remaining roles in the tier are skipped)
// pool        → fallback list when all tiers are exhausted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mafia role assignment tiers.
 * Discord equivalent: gamedata.mafiaRoles.tiers
 * Tier 1 (Silencer) is assigned last/least frequently.
 * Godfather is always assigned first (tier 2 with Framer).
 */
const MAFIA_TIERS = {
  1: { roles: ["Silencer"], pick: false },
  2: { roles: ["Framer", "Godfather"], pick: false },
  3: { roles: ["Mafioso"], pick: false },
  pool: [],
};

/**
 * Village role assignment tiers.
 * Discord equivalent: gamedata.villageRoles.tiers
 */
const VILLAGE_TIERS = {
  1: { roles: ["Doctor", "Detective"], pick: false },
  2: { roles: ["Vigilante", "Mayor"], pick: false },
  3: { roles: ["Distractor", "Jailer"], pick: 1 },
  4: { roles: ["PI", "Spy"], pick: 1 },
  pool: ["Distractor", "PI", "Spy"],
};

/**
 * Neutral role assignment tiers.
 * Discord equivalent: gamedata.neutralRoles.tiers
 */
const NEUTRAL_TIERS = {
  1: { roles: ["Executioner", "Jester"], pick: 1 },
  2: { roles: ["Baiter", "Arsonist"], pick: 1 },
  pool: ["Baiter", "Arsonist"],
};

// ─────────────────────────────────────────────────────────────────────────────
// ALIGNMENT DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const ALIGN_EMOJI = {
  Mafia: "🔴",
  Village: "🟢",
  Neutral: "🔵",
};

const ALIGN_COLOR_HEX = {
  Mafia: "#d50000",
  Village: "#1e8c00",
  Neutral: "#1984ff",
};

module.exports = {
  ROLES,
  MAFIA_TIERS,
  VILLAGE_TIERS,
  NEUTRAL_TIERS,
  ALIGN_EMOJI,
  ALIGN_COLOR_HEX,
};
