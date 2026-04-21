"use strict";

/**
 * statusMonitor.js
 *
 * Adds a /api/agent-status endpoint to the local UI server.
 * Returns live stats from the WebSocket client for the monitoring page.
 *
 * Also polls Laravel's /api/agent/health/vendor every 15s
 * and caches the result so the UI page can display it without
 * hammering Laravel.
 *
 * Usage in uiServer.js:
 *   const { attachStatusMonitor } = require('./statusMonitor');
 *   attachStatusMonitor(app, config);    // call after app is created
 *
 * Then in agent.js, after startWsClient():
 *   const { setWsClientRef } = require('./ui/statusMonitor');
 *   setWsClientRef({ getStats });
 */

const axios  = require("axios");
const logger = require("../utils/logger");
const config = require("../utils/config");

let _wsClientRef = null;   // set by agent.js after wsClient starts
let _cachedHealth = null;  // cached from Laravel
let _healthFetchedAt = null;

/**
 * Called by agent.js to give the monitor access to wsClient stats.
 */
function setWsClientRef(ref) {
  _wsClientRef = ref;
}

/**
 * Fetch health data from Laravel and cache it.
 */
async function fetchLaravelHealth() {
  if (!config.laravelUrl || !config.agentKey) return;

  try {
    const res = await axios.get(`${config.laravelUrl}/api/agent/health/vendor`, {
      headers: {
        "X-Agent-Key":  config.agentKey,
        "X-Agent-Id":   config.agentId,
        "Accept":       "application/json",
      },
      timeout: 8000,
    });
    _cachedHealth    = res.data;
    _healthFetchedAt = new Date().toISOString();
  } catch (err) {
    logger.debug("StatusMonitor: health fetch failed", { error: err.message });
  }
}

// Poll Laravel health every 15 seconds
setInterval(fetchLaravelHealth, 15_000);
// Fetch immediately on load
fetchLaravelHealth();

/**
 * Attach the /api/agent-status route to the Express app.
 */
function attachStatusMonitor(app) {
  app.get("/api/agent-status", (req, res) => {
    const wsStats = _wsClientRef ? _wsClientRef.getStats() : {
      mode: "websocket",
      running: false,
      connected: false,
      connectionState: "not started",
    };

    res.json({
      agent: {
        id:          config.agentId,
        version:     config.agentVersion || "2.0.0",
        vendorId:    config.vendorId,
        laravelUrl:  config.laravelUrl,
        configured:  !!(config.laravelUrl && config.agentKey && config.vendorId),
      },
      websocket: wsStats,
      laravel:   _cachedHealth,
      healthFetchedAt: _healthFetchedAt,
      serverTime: new Date().toISOString(),
    });
  });
}

module.exports = { attachStatusMonitor, setWsClientRef, fetchLaravelHealth };