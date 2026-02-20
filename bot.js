/**
 * bot.js — DEBUG BUILD
 * Every meaningful event is logged with a wall-clock timestamp and duration
 * so you can pinpoint exactly where the hang occurs in the timeline.
 */

"use strict";

require("dotenv").config();

const { Telegraf } = require("telegraf");
const gameState = require("./gameState");
const actionRegistry = require("./roles/actionRegistry");
const dayVoting = require("./roles/dayVoting");

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG LOGGER
// All log lines share the same format so you can grep / sort by tag:
//   [HH:MM:SS.mmm] [TAG] message
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
// BOT INIT
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  err("INIT", "BOT_TOKEN not set in environment / .env file.");
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

log(
  "INIT",
  `Admin IDs: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "(none)"}`,
);

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90_000 });

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.catch((error, ctx) => {
  const updateId = ctx?.update?.update_id ?? "?";
  const from = ctx?.from?.id ?? "?";
  err(
    "BOT.CATCH",
    `update_id=${updateId} from=${from} — ${error.stack ?? error.message}`,
  );
  ctx
    ?.reply("⚠️ An internal error occurred. Please try again.")
    .catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND LOADER
// ─────────────────────────────────────────────────────────────────────────────

const commands = new Map();
const commandModules = [
  require("./commands/join"),
  require("./commands/leave"),
  require("./commands/party"),
  require("./commands/remove"),
  require("./commands/write"),
  require("./commands/erase"),
  require("./commands/setup"),
  require("./commands/startgame"),
  require("./commands/endgame"),
  require("./commands/kick"),
  require("./commands/settings"),
  require("./commands/roles"),
];

for (const mod of commandModules) {
  commands.set(mod.name, mod);
  log("INIT", `Loaded command: /${mod.name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 0 — UPDATE RECEIPT + LAG TELEMETRY
// Fires for EVERY update before anything else. Shows lag between when Telegram
// queued the update (message.date) and when we actually process it.
// ─────────────────────────────────────────────────────────────────────────────

const STALE_MESSAGE_THRESHOLD_S = 30;

bot.use((ctx, next) => {
  const updateId = ctx.update?.update_id ?? "?";
  const from = ctx.from?.id ?? "?";
  const updateType = ctx.updateType ?? "unknown";

  log(
    "UPDATE",
    `update_id=${updateId} type=${updateType} from=${from} phase=${gameState.phase}`,
  );

  // Lag check for plain messages
  const msgDate = ctx.message?.date ?? null;
  if (msgDate !== null) {
    const nowS = Math.floor(Date.now() / 1000);
    const lagS = nowS - msgDate;
    const text = ctx.message?.text?.slice(0, 60) ?? "(non-text)";

    if (lagS > STALE_MESSAGE_THRESHOLD_S) {
      warn(
        "LAG",
        `STALE DROP lag=${lagS}s update_id=${updateId} text="${text}"`,
      );
      return;
    } else if (lagS > 10) {
      warn("LAG", `HIGH lag=${lagS}s update_id=${updateId} text="${text}"`);
    } else if (lagS > 2) {
      log("LAG", `moderate lag=${lagS}s update_id=${updateId}`);
    } else {
      log("LAG", `ok lag=${lagS}s update_id=${updateId}`);
    }
  }

  // Log every callback_query with its data (button presses)
  if (ctx.callbackQuery) {
    const data = ctx.callbackQuery.data ?? "(none)";
    const btnDate = ctx.callbackQuery.message?.date ?? "?";
    log(
      "CALLBACK",
      `update_id=${updateId} from=${from} data="${data.slice(0, 80)}" btn_msg_date=${btnDate}`,
    );
  }

  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 1 — GLOBAL ERROR BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const start = Date.now();
  try {
    await next();
    const elapsed = Date.now() - start;
    if (elapsed > 3000) {
      warn("MW", `Slow middleware chain: ${elapsed}ms`);
    } else {
      log("MW", `Chain done in ${elapsed}ms`);
    }
  } catch (error) {
    err(
      "MW",
      `Chain threw after ${Date.now() - start}ms — ${error.stack ?? error.message}`,
    );
    if (ctx.chat) {
      await ctx
        .reply("⚠️ An internal error occurred. Please try again.")
        .catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 2 — IGNORE BOTS
// ─────────────────────────────────────────────────────────────────────────────

bot.use((ctx, next) => {
  if (ctx.from?.is_bot) {
    log("MW", `Ignored bot update from=${ctx.from.id}`);
    return;
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// DM RATE-LIMITER
// ─────────────────────────────────────────────────────────────────────────────

const _muteNotifiedAt = new Map();
const MUTE_DM_COOLDOWN = 30_000;

function shouldNotify(userId) {
  const last = _muteNotifiedAt.get(userId) ?? 0;
  if (Date.now() - last > MUTE_DM_COOLDOWN) {
    _muteNotifiedAt.set(userId, Date.now());
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// IS GROUP MESSAGE
// ─────────────────────────────────────────────────────────────────────────────

function isGroupMessage(ctx) {
  const type = ctx.chat?.type;
  if (type !== "group" && type !== "supergroup") return false;
  if (!ctx.message) return false;
  const first = ctx.message.entities?.[0];
  if (first?.type === "bot_command" && first.offset === 0) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 3 — NIGHT PHASE GATE
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "night" && isGroupMessage(ctx)) {
    const from = ctx.from.id;
    log(
      "GATE-NIGHT",
      `Blocking from=${from} text="${ctx.message?.text?.slice(0, 40)}"`,
    );
    await ctx.deleteMessage().catch(() => {});

    if (shouldNotify(from)) {
      const player = gameState.players?.get(from) ?? null;
      const msg = player
        ? `🌙 <b>It's night — the town is asleep.</b>\n\nCheck your DMs for your action prompt.`
        : `🌙 <b>The game is in its night phase.</b>\n\nGroup messages are disabled until morning.`;

      log("GATE-NIGHT", `DMing from=${from}`);
      const t = Date.now();
      await bot.telegram
        .sendMessage(from, msg, { parse_mode: "HTML" })
        .catch((e) => {
          err(
            "GATE-NIGHT",
            `DM failed from=${from} after ${Date.now() - t}ms — ${e.message}`,
          );
        });
      log("GATE-NIGHT", `DM sent to from=${from} in ${Date.now() - t}ms`);
    }
    return;
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 4 — SILENCED PLAYER GATE
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.phase === "day" && isGroupMessage(ctx)) {
    const player = gameState.players?.get(ctx.from.id) ?? null;
    if (player?.silencedLastRound) {
      log("GATE-SILENCE", `Blocking silenced from=${ctx.from.id}`);
      await ctx.deleteMessage().catch(() => {});
      if (shouldNotify(ctx.from.id)) {
        await bot.telegram
          .sendMessage(ctx.from.id, `🤫 <b>You are silenced today.</b>`, {
            parse_mode: "HTML",
          })
          .catch((e) => err("GATE-SILENCE", `DM failed — ${e.message}`));
      }
      return;
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE 5 — DEAD PLAYER GATE
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (gameState.isGameActive && isGroupMessage(ctx)) {
    const player = gameState.players?.get(ctx.from.id) ?? null;
    if (player && !player.isAlive) {
      log(
        "GATE-DEAD",
        `Blocking dead player from=${ctx.from.id} username=${player.username}`,
      );
      await ctx.deleteMessage().catch(() => {});
      if (shouldNotify(ctx.from.id)) {
        await bot.telegram
          .sendMessage(
            ctx.from.id,
            `👻 <b>You are dead and cannot communicate with the living.</b>`,
            {
              parse_mode: "HTML",
            },
          )
          .catch((e) => err("GATE-DEAD", `DM failed — ${e.message}`));
      }
      return;
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// /roles and /role
// ─────────────────────────────────────────────────────────────────────────────

bot.command("roles", async (ctx) => {
  log("CMD", `/roles from=${ctx.from.id}`);
  await commands.get("roles").execute(ctx, [], gameState, bot, "all");
});

bot.command("role", async (ctx) => {
  log("CMD", `/role from=${ctx.from.id}`);
  const args = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  await commands.get("roles").execute(ctx, args, gameState, bot, "single");
});

// ─────────────────────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  log("CMD", `/start from=${ctx.from.id} chatType=${ctx.chat.type}`);
  if (ctx.chat.type !== "private") {
    return ctx.reply(
      `👋 <b>Mafiaville Bot</b>\n\nCommands:\n/join — Join the lobby\n/leave — Leave the lobby\n` +
        `/party — List current players\n/setup — Assign roles (host only)\n` +
        `/startgame — Start the game (host only)\n/endgame — Force-end (host only)`,
      { parse_mode: "HTML" },
    );
  }
  await ctx.reply(
    `✅ <b>You're all set!</b>\n\nI can now send you private messages.\n\nJoin with /join in the group.`,
    { parse_mode: "HTML" },
  );
  const player = gameState.players.get(ctx.from.id);
  if (player) log("CMD", `DM confirmed: ${player.username} (${ctx.from.id})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND DISPATCHER — logs every command invocation and duration
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, cmd] of commands) {
  bot.command(name, async (ctx) => {
    const args = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
    const start = Date.now();
    log("CMD", `/${name} from=${ctx.from.id} args=[${args.join(", ")}]`);
    await cmd.execute(ctx, args, gameState, bot);
    log("CMD", `/${name} finished in ${Date.now() - start}ms`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT ACTION CALLBACK HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^na/, async (ctx) => {
  const data = ctx.callbackQuery?.data;
  const from = ctx.from?.id;
  log("NA-CB", `from=${from} data="${data?.slice(0, 80)}"`);

  if (!data || !from) {
    warn("NA-CB", "Missing data or from");
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const parts = data.split(":");
  if (parts.length < 4) {
    warn("NA-CB", `Malformed callback_data="${data}"`);
    await ctx.answerCbQuery("⚠️ Malformed action data.").catch(() => {});
    return;
  }

  const prefix = parts[0];
  const round = parts[1];
  const actorId = parts[2];
  const value = parts.slice(3).join(":");

  log(
    "NA-CB",
    `prefix=${prefix} round=${round} actorId=${actorId} value="${value}"`,
  );

  if (String(from) !== actorId) {
    warn("NA-CB", `Wrong player: from=${from} vs actorId=${actorId}`);
    await ctx.answerCbQuery("⚠️ This isn't your prompt.").catch(() => {});
    return;
  }

  if (!gameState.players) {
    warn("NA-CB", "gameState.players is null/undefined");
    await ctx
      .answerCbQuery("⚠️ Game state not ready.", { show_alert: true })
      .catch(() => {});
    return;
  }

  const key = `${prefix}:${round}:${actorId}`;
  const inReg = actionRegistry.has(key);
  log("NA-CB", `Looking up key="${key}" inRegistry=${inReg}`);

  const t = Date.now();
  const resolved = actionRegistry.resolve(key, value);
  log(
    "NA-CB",
    `resolve key="${key}" resolved=${resolved} in ${Date.now() - t}ms`,
  );

  if (resolved) {
    log("NA-CB", `Answering cbQuery + collapsing keyboard for key="${key}"`);
    const t2 = Date.now();
    await ctx.answerCbQuery("✅ Action recorded!").catch((e) => {
      err(
        "NA-CB",
        `answerCbQuery failed in ${Date.now() - t2}ms — ${e.message}`,
      );
    });
    log("NA-CB", `answerCbQuery done in ${Date.now() - t2}ms`);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch((e) => {
      warn("NA-CB", `editMessageReplyMarkup failed (non-fatal) — ${e.message}`);
    });
  } else {
    warn("NA-CB", `Stale button: key="${key}" not in registry`);
    await ctx
      .answerCbQuery(
        "⚠️ This action is no longer valid. The game may have been reset.",
        {
          show_alert: true,
        },
      )
      .catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOMINATION VOTE CALLBACK
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_nom:/, async (ctx) => {
  const from = ctx.from?.id;
  const data = ctx.callbackQuery?.data;
  log("VOTE-NOM", `from=${from} data="${data}"`);

  await ctx.answerCbQuery().catch(() => {});
  if (!data || !from) return;

  const parts = data.split(":");
  if (parts.length < 4) {
    warn("VOTE-NOM", `Malformed: "${data}"`);
    return;
  }

  const sessionId = parts[1];
  const targetId = Number(parts[3]);

  if (ctx.from.is_bot) return;

  if (sessionId !== gameState.sessionId) {
    warn(
      "VOTE-NOM",
      `Stale session got="${sessionId}" want="${gameState.sessionId}"`,
    );
    await ctx
      .answerCbQuery("⚠️ Vote from previous game.", { show_alert: true })
      .catch(() => {});
    return;
  }

  if (!gameState.players) {
    warn("VOTE-NOM", "gameState.players null");
    return;
  }

  log("VOTE-NOM", `Processing vote from=${from} target=${targetId}`);
  const t = Date.now();
  await dayVoting.receiveNominationVote(from, targetId, ctx, gameState, bot);
  log("VOTE-NOM", `receiveNominationVote done in ${Date.now() - t}ms`);
});

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION VOTE CALLBACK
// ─────────────────────────────────────────────────────────────────────────────

bot.action(/^vote_exec:/, async (ctx) => {
  const from = ctx.from?.id;
  const data = ctx.callbackQuery?.data;
  log("VOTE-EXEC", `from=${from} data="${data}"`);

  await ctx.answerCbQuery().catch(() => {});
  if (!data || !from) return;

  const parts = data.split(":");
  if (parts.length < 5) {
    warn("VOTE-EXEC", `Malformed: "${data}"`);
    return;
  }

  const sessionId = parts[1];
  const choice = parts[4];

  if (ctx.from.is_bot) return;

  if (sessionId !== gameState.sessionId) {
    warn(
      "VOTE-EXEC",
      `Stale session got="${sessionId}" want="${gameState.sessionId}"`,
    );
    await ctx
      .answerCbQuery("⚠️ Vote from previous game.", { show_alert: true })
      .catch(() => {});
    return;
  }

  if (!gameState.players) {
    warn("VOTE-EXEC", "gameState.players null");
    return;
  }

  log("VOTE-EXEC", `Processing exec vote from=${from} choice=${choice}`);
  const t = Date.now();
  await dayVoting.receiveExecutionVote(from, choice, ctx, gameState, bot);
  log("VOTE-EXEC", `receiveExecutionVote done in ${Date.now() - t}ms`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CATCH-ALL CALLBACK
// ─────────────────────────────────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  warn(
    "CALLBACK",
    `Unhandled callback data="${ctx.callbackQuery?.data?.slice(0, 60)}"`,
  );
  await ctx.answerCbQuery().catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal) {
  log("SHUTDOWN", `${signal} received`);
  actionRegistry.clear();
  dayVoting.clearActiveSessions();
  bot.stop(signal);
  process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH — flush ONCE on cold start, never inside the retry loop
// ─────────────────────────────────────────────────────────────────────────────

const LAUNCH_CONFIG = {
  allowedUpdates: ["message", "callback_query", "chat_member"],
  dropPendingUpdates: false,
  polling: { timeout: 30, limit: 100 },
};

async function flushPendingUpdates() {
  log("LAUNCH", "Flushing pending updates (cold start)...");
  const t = Date.now();
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    log("LAUNCH", `Flush done in ${Date.now() - t}ms`);
  } catch (e) {
    warn(
      "LAUNCH",
      `Flush failed (non-fatal) in ${Date.now() - t}ms — ${e.message}`,
    );
  }
}

async function launchWithRetry(maxRetries = 5, delayMs = 10_000) {
  await flushPendingUpdates();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log("LAUNCH", `Attempt ${attempt}/${maxRetries}...`);
    const t = Date.now();
    try {
      await bot.launch(LAUNCH_CONFIG);
      log("LAUNCH", `✅ Running — attempt ${attempt} took ${Date.now() - t}ms`);
      return;
    } catch (e) {
      err(
        "LAUNCH",
        `Attempt ${attempt} failed after ${Date.now() - t}ms — ${e.message}`,
      );
      if (e.response?.error_code === 409 || e.message?.includes("409")) {
        err("LAUNCH", "409 Conflict. Exiting for clean restart.");
        process.exit(1);
      }
      if (attempt < maxRetries) {
        log(
          "LAUNCH",
          `Waiting ${delayMs / 1000}s before retry (no flush on retry)...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        err("LAUNCH", "All attempts failed. Exiting.");
        process.exit(1);
      }
    }
  }
}

launchWithRetry();
