"use strict";

require("dotenv").config();

const logger = require("./utils/logger");
const config = require("./utils/config");
const { startUiServer }            = require("./ui/uiServer");
const { startPoller, stopPoller, getStats } = require("./poller/poller");

async function main() {
  logger.info("Print agent starting", {
    version:   config.agentVersion,
    agentId:   config.agentId,
    setupMode: config.isSetupMode,
    transport: "polling",   // ← polling mode, not websocket
  });

  // Always start the local UI server (scanner + setup wizard)
  startUiServer(config.uiPort);

  if (config.isSetupMode) {
    console.log(`\n  Setup mode — open the wizard:\n  http://localhost:${config.uiPort}\n`);
    return;
  }

  if (!config.laravelUrl || !config.agentKey || !config.vendorId) {
    logger.error("Agent config incomplete — starting in setup mode", {
      hasUrl:      !!config.laravelUrl,
      hasKey:      !!config.agentKey,
      hasVendorId: !!config.vendorId,
    });
    console.log(`\n  Config incomplete. Open the setup wizard:\n  http://localhost:${config.uiPort}\n`);
    return;
  }

  // Start DB polling loop
  startPoller();

  // Log stats every 60s
  setInterval(() => {
    const stats = getStats();
    logger.info("Agent stats", stats);
  }, 60_000);

  console.log(`\n  Print agent running (DB polling mode)`);
  console.log(`  Polling: ${config.laravelUrl} every ${config.pollIntervalMs || 3000}ms`);
  console.log(`  Vendor:  #${config.vendorId}`);
  console.log(`  UI:      http://localhost:${config.uiPort}\n`);
}

function shutdown(signal) {
  logger.info(`${signal} — shutting down`);
  stopPoller();
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
  logger.error("Startup failed", { error: err.message });
  process.exit(1);
});