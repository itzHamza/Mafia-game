/**
 * roles/actionRegistry.js
 *
 * In-memory registry mapping callback-data keys → Promise resolver functions.
 *
 * Discord equivalent: prompt.awaitReactions(filter, { time }) was self-contained —
 * the resolver lived inside the closure that created the Discord message.
 *
 * Telegram problem: bot.action() is GLOBAL. Any button press anywhere triggers it.
 * Solution: every night prompt registers a unique key here. The global handler
 * calls registry.resolve(key, value), routing the press back to the right Promise.
 *
 * Key format: "<prefix>:<round>:<actorId>"
 *   e.g.  "na:1:123456789"        standard single-target action
 *         "na_pi1:1:123456789"    PI first selection
 *         "na_mayor:1:123456789"  Mayor Y/N reveal
 *         "na_jailer:1:123456789" Jailer Y/N execute
 *
 * Callback data format (what's stored in the button): "<key>:<value>"
 *   e.g.  "na:1:123456789:987654321"  → selected player 987654321
 *         "na:1:123456789:skip"        → player chose to skip
 *         "na_mayor:1:123456789:yes"   → Mayor chose to reveal
 */

"use strict";

const _registry = new Map();

module.exports = {
  /**
   * Register a resolver function for a key.
   * Discord equivalent: the resolve() callback inside awaitReactions().then()
   * @param {string}   key
   * @param {Function} resolveFn  Called with the selection value when button pressed.
   */
  register(key, resolveFn) {
    _registry.set(key, resolveFn);
  },

  /**
   * Resolve and deregister a pending action.
   * Called by the global bot.action() handler in bot.js.
   * @param {string} key
   * @param {string} value  The selection value from callback_data.
   * @returns {boolean}     Whether a resolver was found and called.
   */
  resolve(key, value) {
    const fn = _registry.get(key);
    if (!fn) return false;
    _registry.delete(key);
    fn(value);
    return true;
  },

  /**
   * Remove a key without resolving its Promise.
   * Called when the night timer fires first — the Promise is resolved
   * to null separately by the timeout callback.
   * @param {string} key
   */
  deregister(key) {
    _registry.delete(key);
  },

  /** @param {string} key @returns {boolean} */
  has(key) {
    return _registry.has(key);
  },

  /**
   * Clear all pending resolvers.
   * Called between rounds to prevent stale button presses from a previous
   * night carrying over.
   * Discord equivalent: N/A — Discord messages with reactions became inert
   * automatically after awaitReactions timed out.
   */
  clear() {
    _registry.clear();
  },
};
