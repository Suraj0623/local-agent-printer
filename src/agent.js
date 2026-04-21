"use strict";

/**
 * src/agent.js — WebSocket mode entry point
 *
 * Matches project structure:
 *   package.json → "start": "node src/agent.js"
 *   src/
 *     agent.js          ← this file
 *     ws/wsClient.js    ← WebSocket transport
 *     utils/config.js   ← config (updated with Pusher keys)
 *     utils/logger.js   ← unchanged
 *     ui/uiServer.js    ← setup wizard (unchanged)
 *     ui/statusMonitor.js
 *     registry/registry.js  ← unchanged
 *     adapters/printService.js ← unchanged
 */

require("dotenv").config();

const logger = require("./utils/logger");
const config = require("./utils/config");
const { startUiServer }                         = require("./ui/uiServer");
const { startWsClient, stopWsClient, getStats } = require("./ws/wsClient");

// statusMonitor is optional — only load if it exists
let setWsClientRef = () => {};
try {
  ({ setWsClientRef } = require("./ui/statusMonitor"));
} catch (_) {
  // statusMonitor not present — skip silently
}

async function main() {
  logger.info("Print agent starting", {
    version:   config.agentVersion,
    agentId:   config.agentId,
    vendorId:  config.vendorId,
    laravelUrl: config.laravelUrl,
    setupMode: config.isSetupMode,
    transport: "websocket",
  });

  // Always start the local UI server (setup wizard + scanner)
  startUiServer(config.uiPort);

  if (config.isSetupMode) {
    console.log(`\n  Setup mode — open the wizard:\n  http://localhost:${config.uiPort}\n`);
    return;
  }

  // ── Validate required config ──────────────────────────────────────────────
  const missing = [];
  if (!config.laravelUrl) missing.push("LARAVEL_URL");
  if (!config.agentKey)   missing.push("AGENT_KEY");
  if (!config.vendorId)   missing.push("VENDOR_ID");

  if (missing.length) {
    logger.error("Agent config incomplete", { missing });
    console.log(`\n  Config missing: ${missing.join(", ")}`);
    console.log(`  Open the setup wizard: http://localhost:${config.uiPort}\n`);
    return;
  }

  // ── Validate Pusher config ────────────────────────────────────────────────
  // pusherKey must be set. For local dev (PUSHER_HOST set) the key just needs
  // to match Laravel's PUSHER_APP_KEY — any non-empty string works.
  if (!config.pusherKey) {
    logger.error("PUSHER_APP_KEY not set in .env", {
      hint: config.pusherHost
        ? "Set PUSHER_APP_KEY to any string matching Laravel PUSHER_APP_KEY"
        : "Get PUSHER_APP_KEY from pusher.com dashboard, or set PUSHER_HOST for self-hosted",
    });
    console.error("\n  ERROR: PUSHER_APP_KEY not set in .env\n");
    console.error("  For local dev with laravel-websockets, set:");
    console.error("    PUSHER_APP_KEY=digitalwaiter-local-key");
    console.error("    PUSHER_HOST=127.0.0.1");
    console.error("    PUSHER_PORT=6001\n");
    process.exit(1);
  }

  // Warn if still using placeholder value
  if (config.pusherKey === "your_pusher_app_key") {
    logger.error("PUSHER_APP_KEY still set to placeholder value", {
      hint: "Replace 'your_pusher_app_key' with a real key in .env",
    });
    console.error("\n  ERROR: PUSHER_APP_KEY is still the placeholder 'your_pusher_app_key'\n");
    console.error("  For local dev: set PUSHER_APP_KEY=digitalwaiter-local-key and PUSHER_HOST=127.0.0.1\n");
    process.exit(1);
  }

  // ── Start WebSocket client ────────────────────────────────────────────────
  startWsClient();

  // Connect live stats to the monitor dashboard (if statusMonitor present)
  setWsClientRef({ getStats });

  // ── Log stats every 60 seconds ────────────────────────────────────────────
  setInterval(() => {
    const stats = getStats();
    logger.info("Agent stats", stats);
  }, 60_000);

  const mode = config.pusherHost ? `self-hosted ws://${config.pusherHost}:${config.pusherPort}` : `Pusher.com cluster=${config.pusherCluster}`;

  console.log(`\n  ✓ Print agent running (WebSocket mode)`);
  console.log(`  Laravel:  ${config.laravelUrl}`);
  console.log(`  Vendor:   #${config.vendorId}`);
  console.log(`  Channel:  private-vendor.${config.vendorId}`);
  console.log(`  WS:       ${mode}`);
  console.log(`  UI:       http://localhost:${config.uiPort}\n`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down`);
  stopWsClient();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});

main().catch(err => {
  logger.error("Startup failed", { error: err.message, stack: err.stack });
  process.exit(1);
});