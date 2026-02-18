# Mafiaville Bot — Telegram Edition

A Telegram bot for running games of the classic social deduction party game **Mafia**, ported from Discord to Telegram using [Telegraf](https://telegraf.js.org/).

> Originally built for Discord with `discord.js`. This version replaces guild channels, voice rooms, and emoji reactions with Telegram inline keyboards, DMs, and middleware-based access control.

---

## What is Mafia?

[Mafia](https://en.wikipedia.org/wiki/Mafia_%28party_game%29) is a role-playing party game in which players are secretly divided into three factions:

- **Mafia** — know each other's identities, eliminate villagers each night
- **Village** — unaware of each other's roles, vote to eliminate the Mafia each day
- **Neutrals** — pursue their own independent win conditions

---

## Features

- 16 unique roles across Mafia, Village, and Neutral alignments (5–16 players)
- Role assignment with tiered randomness, sent privately via DM at setup
- Night phase: per-role action prompts delivered as inline keyboard DMs
- Day phase: live nomination vote and execution vote in the group chat, with real-time tally updates
- Silenced players are intercepted at the middleware level (message deletion + DM notice)
- Dead players are blocked from group chat communication mid-game
- Last Will system: players can write and edit a will that is revealed on death
- Godfather succession: Mafioso → Framer → Silencer automatically promoted on Godfather death
- Configurable game settings (night time, day time, voting time, Mafia hidden mode)
- Graceful rollback if any player cannot receive a DM during setup
- Force-end and mid-game kick commands for hosts

---

## Roles

### Mafia
| Role | Ability |
|---|---|
| **Godfather** | Orders a kill each night |
| **Mafioso** | Carries out the Godfather's kill; inherits leadership if Godfather dies |
| **Framer** | Makes an innocent appear as Mafia to the Detective |
| **Silencer** | Silences a player every other night, preventing them from speaking at Town Hall |

### Village
| Role | Ability |
|---|---|
| **Doctor** | Protects one player from a Mafia attack each night (no repeats) |
| **Detective** | Investigates one player per night for Mafia affiliation |
| **Vigilante** | Shoots a player each night; dies of guilt if the target is a Villager |
| **Mayor** | Can reveal their identity for an extra vote; becomes a high-value target |
| **Jailer** | Jails a player every other night, blocking their action and protecting them |
| **Distractor** | Causes a player's night action to fail every other night |
| **PI** | Compares two players to determine if they're on the same side |
| **Spy** | Follows a player to learn who they visited during the night |

### Neutral
| Role | Win Condition |
|---|---|
| **Jester** | Get yourself lynched by the town |
| **Executioner** | Get your assigned target lynched (becomes Jester if they die at night) |
| **Baiter** | Bait three players into visiting your rigged house and survive |
| **Arsonist** | Douse players over multiple nights, then ignite them all simultaneously |

---

## Requirements

- Node.js >= 18.0.0
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)

---

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/mafia-bot-telegram.git
   cd mafia-bot-telegram
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a `.env` file**
   ```env
   BOT_TOKEN=your_telegram_bot_token_here
   ADMIN_IDS=123456789,987654321   # optional: comma-separated Telegram user IDs with host privileges
   ```

4. **Add role images** *(optional)*
   Place role image files in an `images/` directory. The bot falls back to text-only messages if images are missing.

5. **Run the bot**
   ```bash
   npm start          # production
   npm run dev        # development (auto-restarts on file changes)
   ```

---

## Commands

### Lobby Commands
| Command | Description |
|---|---|
| `/join` | Join the lobby, or create one if none exists |
| `/leave` | Leave the current lobby |
| `/party` | List all players in the lobby |
| `/remove @player` | Remove a player from the lobby *(host only)* |

### Host Commands
| Command | Description |
|---|---|
| `/setup` | Assign roles and send DMs to all players |
| `/startgame` | Begin the game after setup is complete |
| `/endgame` | Force-end the current game and reset to lobby |
| `/kick @player` | Remove a player from the game mid-round |
| `/settings [key] [value]` | View or change game settings |

### Player Commands (DM only)
| Command | Description |
|---|---|
| `/write <text>` | Add a line to your Last Will |
| `/erase <line>` | Remove a line from your Last Will |

### Settings
| Key | Default | Range | Description |
|---|---|---|---|
| `nighttime` | `60` | 20–300s | Duration of each night phase |
| `daytime` | `120` | 30–600s | Duration of each day/voting phase |
| `votingtime` | `30` | 10–120s | Defence time for a nominated player |
| `mafiahidden` | `false` | true/false | Lowers player threshold for extra Mafia slots |

---

## How to Play

### Before the Game
1. All players use `/join` in the group chat to enter the lobby.
2. Each player must have started a private chat with the bot (tap the bot's profile → **Start**) so it can send DMs.
3. The host runs `/setup` to assign roles. Everyone receives their role card privately.
4. The host runs `/startgame` to begin.

### Night Phase
Each night, the bot DMs every living player an inline keyboard with their available actions. Players have a configurable window to respond. Jailed players cannot act.

### Day Phase
Each morning, the bot announces the night's events, then opens a nomination vote in the group chat. If a player reaches the nomination threshold, they have a short window to make their case before a guilty/innocent vote is held. Execution removes the player from the game and reveals their role and Last Will.

### Winning
- **Mafia** wins when their numbers equal or outnumber the non-Mafia players.
- **Village** wins when all Mafia members are eliminated.
- **Neutrals** each have unique win conditions that can trigger independently.

---

## Architecture Notes

- **`bot.js`** — Entry point. Registers middleware, loads commands, wires action handlers.
- **`gameState.js`** — Singleton holding all mutable game state.
- **`roles/actionRegistry.js`** — Routes global Telegram button callbacks to the correct per-player night action Promises.
- **`roles/nightPrompts.js`** — Per-role DM prompt senders for the night phase.
- **`roles/nightResolver.js`** — Resolves all night actions in priority order.
- **`roles/dayVoting.js`** — Nomination and execution vote sessions with live tally updates.
- **`roles/dayAnnouncements.js`** — Night result and day attendance announcements.
- **`roles/roleData.js`** — Static role definitions and tier configurations.

---

## Key Differences from the Discord Version

| Discord | Telegram |
|---|---|
| Per-player channel permission overwrites | Middleware intercepts and deletes messages |
| Voice channel movement | Phase change announcements |
| Emoji reactions for voting | Inline keyboard buttons with live tally edits |
| `awaitReactions()` per message | Global `bot.action()` routed via `actionRegistry` |
| DM any guild member freely | User must `/start` the bot before DMs work |
| Godfather's Lair voice channel | DM listing Mafia teammates sent at setup |

---

## License

MIT