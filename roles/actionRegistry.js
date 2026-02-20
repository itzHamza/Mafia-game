/**
 * roles/actionRegistry.js
 *
 * Keeps track of pending night-action Promises.
 * When a player presses a button, the matching Promise is resolved here.
 */

"use strict";

const { warn } = require("../logger");

const _registry = new Map();

module.exports = {
  register(key, resolveFn) {
    _registry.set(key, resolveFn);
  },

  resolve(key, value) {
    const fn = _registry.get(key);
    if (!fn) {
      // Button press arrived after the action window closed — safe to ignore
      return false;
    }
    _registry.delete(key);
    fn(value);
    return true;
  },

  deregister(key) {
    _registry.delete(key);
  },

  has(key) {
    return _registry.has(key);
  },

  clear() {
    _registry.clear();
  },
};
