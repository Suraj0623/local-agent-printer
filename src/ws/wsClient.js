"use strict";

/**
 * wsClient.js — WebSocket client replacing the poll loop.
 *
 * Connects to Laravel Reverb using pusher-js (same protocol
 * as Pusher — Reverb is compatible).
 *
 * What it does:
 *   1. Connects to ws://yourapp.com:8080 via pusher-js
 *   2. Authenticates channel subscription via POST /api/agent/broadcasting/auth
 *   3. Subscribes to private-vendor.{vendorId}
 *   4. Listens for print-job.created events
 *   5. On each event: dispatches print job immediately (no polling)
 *   6. On reconnect: catchup poll to fetch any missed jobs
 *   7. ACKs every job back to Laravel via REST
 *
 * The print_jobs table is still the system of record —
 * WebSocket is just the delivery mechanism.
 */

const {Pusher}  = require("pusher-js");
const axios   = require("axios");
const logger  = require("../utils/logger");
const config  = require("../utils/config");
const registry = require("../registry/registry");
const { executePrintJob } = require("../adapters/printService");

// ── State ─────────────────────────────────────────────────────────────────────
let pusher          = null;
let channel         = null;
let connected       = false;
let reconnectCount  = 0;
let totalJobsDone   = 0;
let totalJobsFailed = 0;
let lastEventAt     = null;
let http            = null;

// ── HTTP client ───────────────────────────────────────────────────────────────
function createHttpClient() {
  return axios.create({
    baseURL: config.laravelUrl,
    timeout: 10_000,
    headers: {
      "X-Agent-Key":     config.agentKey,
      "X-Agent-Id":      config.agentId,
      "X-Agent-Version": config.agentVersion || "1.0.0",
      "Content-Type":    "application/json",
      "Accept":          "application/json",
    },
  });
}

// ── Single job execution ──────────────────────────────────────────────────────

async function processJob(jobData) {
  const maxAttempts = 3;
  const retryDelay  = 5000;

  // Look up local printer config from registry
  const printerConfig = registry.lookup(jobData.printer_node_id);

  if (!printerConfig) {
    const error = `Printer "${jobData.printer_node_id}" not in local registry. ` +
                  `Open http://localhost:${config.uiPort} to assign printers.`;
    logger.error("WS: printer not in registry", {
      jobId:     jobData.id,
      printerId: jobData.printer_node_id,
    });
    await ackJob(jobData.id, "failed", error);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info("WS: printing job", {
        jobId:       jobData.id,
        orderId:     jobData.order_id,
        printerId:   jobData.printer_node_id,
        printerType: jobData.printer_type,
        contentType: jobData.content_type,
        attempt,
      });

      await executePrintJob(jobData, printerConfig);
      await ackJob(jobData.id, "done");
      totalJobsDone++;

      logger.info("WS: job done", { jobId: jobData.id, orderId: jobData.order_id });
      return;

    } catch (err) {
      lastError = err.message;
      logger.warn("WS: print attempt failed", {
        jobId: jobData.id, attempt, error: err.message,
      });
      if (attempt < maxAttempts) {
        await sleep(retryDelay * attempt);
      }
    }
  }

  totalJobsFailed++;
  await ackJob(jobData.id, "failed", lastError);
  logger.error("WS: job failed all retries", { jobId: jobData.id, error: lastError });
}

async function ackJob(jobId, status, errorMsg) {
  try {
    await http.post(`/api/agent/jobs/${jobId}/ack`, {
      status,
      error: errorMsg || undefined,
    });
  } catch (err) {
    logger.warn("WS: ack failed (non-fatal)", { jobId, status, error: err.message });
  }
}

// ── Catchup poll — fetch jobs missed while agent was offline ──────────────────

async function catchupPoll() {
  try {
    const response = await http.get("/api/agent/jobs", {
      params: { agent_id: config.agentId },
    });
    const jobs = response.data.jobs || [];

    if (jobs.length > 0) {
      logger.info("WS: catchup poll found missed jobs", { count: jobs.length });
      // Process up to 3 in parallel
      const chunks = [];
      for (let i = 0; i < jobs.length; i += 3) chunks.push(jobs.slice(i, i + 3));
      for (const chunk of chunks) {
        await Promise.allSettled(chunk.map(j => processJob(j)));
      }
    } else {
      logger.debug("WS: catchup poll — no missed jobs");
    }
  } catch (err) {
    logger.warn("WS: catchup poll failed", { error: err.message });
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function buildPusher() {
  const scheme = config.reverbScheme || "http";
  const wsScheme = scheme === "https" ? "wss" : "ws";

  // Pusher.logToConsole = process.env.LOG_LEVEL === "debug";

  return new Pusher(config.reverbAppKey, {
    wsHost:           config.reverbHost,
    wsPort:           parseInt(config.reverbPort, 10),
    wssPort:          parseInt(config.reverbPort, 10),
    cluster:          "mt1",          // required by pusher-js, ignored by Reverb
    forceTLS:         scheme === "https",
    enabledTransports: ["ws", "wss"],
    disableStats:     true,

    // Custom auth endpoint — uses agent_key not session cookie
    authEndpoint: `${config.laravelUrl}/api/agent/broadcasting/auth`,
    auth: {
      headers: {
        "X-Agent-Key":  config.agentKey,
        "X-Agent-Id":   config.agentId,
        "Accept":       "application/json",
      },
    },
  });
}

function connectWebSocket() {
  if (pusher) {
    pusher.disconnect();
    pusher = null;
    channel = null;
  }

  logger.info("WS: connecting to Reverb", {
    host:   config.reverbHost,
    port:   config.reverbPort,
    scheme: config.reverbScheme,
    vendor: config.vendorId,
  });

  pusher = buildPusher();

  // ── Connection state handlers ─────────────────────────────────────────────
  pusher.connection.bind("connected", () => {
    connected = true;
    reconnectCount = 0;
    logger.info("WS: connected to Reverb", {
      socketId: pusher.connection.socket_id,
    });

    // Subscribe to private channel for this vendor
    subscribeToChannel();
  });

  pusher.connection.bind("disconnected", () => {
    connected = false;
    channel   = null;
    logger.warn("WS: disconnected from Reverb");
  });

  pusher.connection.bind("error", (err) => {
    connected = false;
    logger.error("WS: connection error", {
      type:    err.type,
      error:   err.error?.message || String(err),
    });
  });

  // pusher-js handles reconnection automatically with backoff
  pusher.connection.bind("connecting", () => {
    reconnectCount++;
    if (reconnectCount > 1) {
      logger.info("WS: reconnecting", { attempt: reconnectCount });
    }
  });
}

function subscribeToChannel() {
  const channelName = `private-vendor.${config.vendorId}`;

  logger.info("WS: subscribing to channel", { channel: channelName });

  channel = pusher.subscribe(channelName);

  channel.bind("pusher:subscription_succeeded", () => {
    logger.info("WS: channel subscription active", { channel: channelName });

    // Catchup: fetch any jobs that arrived while we were offline
    catchupPoll();
  });

  channel.bind("pusher:subscription_error", (err) => {
    logger.error("WS: channel auth failed", {
      channel: channelName,
      status:  err.status,
      error:   err.error,
      hint:    err.status === 401
        ? "Check AGENT_KEY matches the vendor's agent_key in Laravel"
        : "Check REVERB_APP_KEY matches Laravel REVERB_APP_KEY",
    });
  });

  // ── The main event: print job received ───────────────────────────────────
  channel.bind("print-job.created", (jobData) => {
    lastEventAt = new Date().toISOString();

    logger.info("WS: print job received via WebSocket", {
      jobId:       jobData.id,
      orderId:     jobData.order_id,
      printerId:   jobData.printer_node_id,
      printerType: jobData.printer_type,
    });

    // Process immediately — no polling delay
    processJob(jobData).catch(err => {
      logger.error("WS: unhandled job error", { jobId: jobData.id, error: err.message });
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function startWebSocket() {
  http = createHttpClient();
  connectWebSocket();

  logger.info("WS client started", {
    laravelUrl: config.laravelUrl,
    vendorId:   config.vendorId,
    agentId:    config.agentId,
  });
}

function stopWebSocket() {
  if (pusher) {
    pusher.disconnect();
    pusher   = null;
    channel  = null;
    connected = false;
    logger.info("WS: disconnected");
  }
}

function getStats() {
  return {
    connected,
    reconnectCount,
    totalJobsDone,
    totalJobsFailed,
    lastEventAt,
    socketId: pusher?.connection?.socket_id || null,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startWebSocket, stopWebSocket, getStats };
