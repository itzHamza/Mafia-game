/**
 * roles/actionRegistry.js — DEBUG BUILD
 *
 * Logs every register, resolve, deregister, and clear operation
 * so you can trace exactly which keys are active at any time.
 */

"use strict";

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}
function log(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}
function warn(tag, msg) {
  console.warn(`[${ts()}] [${tag}] ⚠️  ${msg}`);
}

const _registry = new Map();

module.exports = {
  register(key, resolveFn) {
    if (_registry.has(key)) {
      warn(
        "REGISTRY",
        `OVERWRITE existing key="${key}" — possible double-register`,
      );
    }
    _registry.set(key, resolveFn);
    log("REGISTRY", `REGISTER key="${key}" (total=${_registry.size})`);
  },

  resolve(key, value) {
    const fn = _registry.get(key);
    if (!fn) {
      warn(
        "REGISTRY",
        `RESOLVE MISS key="${key}" (total=${_registry.size}) — stale or already resolved`,
      );
      return false;
    }
    _registry.delete(key);
    log(
      "REGISTRY",
      `RESOLVE HIT key="${key}" value="${value}" (remaining=${_registry.size})`,
    );
    fn(value);
    return true;
  },

  deregister(key) {
    const had = _registry.has(key);
    _registry.delete(key);
    if (had) {
      log("REGISTRY", `DEREGISTER key="${key}" (remaining=${_registry.size})`);
    } else {
      warn("REGISTRY", `DEREGISTER MISS key="${key}" — was not registered`);
    }
  },

  has(key) {
    return _registry.has(key);
  },

  clear() {
    const count = _registry.size;
    _registry.clear();
    log("REGISTRY", `CLEAR — removed ${count} pending resolver(s)`);
  },
};
