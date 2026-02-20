/**
 * logger.js — Shared game logger
 * Human-readable logs so anyone can follow what's happening.
 */

"use strict";

function ts() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function log(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}
function warn(tag, msg) {
  console.warn(`[${ts()}] ⚠️  [${tag}] ${msg}`);
}
function err(tag, msg) {
  console.error(`[${ts()}] ❌ [${tag}] ${msg}`);
}

module.exports = { log, warn, err };
