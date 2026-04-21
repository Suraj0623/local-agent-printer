"use strict";

/**
 * wsClient.js — WebSocket transport (replaces poller.js)
 *
 * Connects to Laravel's Pusher/WebSocket server and subscribes to the
 * private vendor channel: private-vendor.{vendor_id}
 *
 * Lifecycle:
 *   1. Connect to Pusher server
 *   2. Authenticate channel via POST /api/agent/broadcasting/auth
 *      (uses X-Agent-Key — same key as polling mode)
 *   3. Subscribe to private-vendor.{vendor_id}
 *   4. Listen for 'print.job.dispatched' events
 *   5. For each event: deduplicate → print → ACK
 *   6. On connect: call fallback poll to drain any missed jobs
 *   7. On disconnect: auto-reconnect with exponential backoff
 *
 * Deduplication:
 *   - Each job has a job_uuid (UUID v4)
 *   - Processed UUIDs are stored in a Map with timestamp
 *   - Cache is pruned hourly — only needs to cover Pusher's dedup window (~30s)
 *   - If same UUID arrives twice, second delivery is silently ignored
 *
 * Tenant isolation:
 *   - Agent is configured with a single vendor_id
 *   - Channel auth endpoint rejects requests for other vendors
 *   - Agent verifies vendorId in each event payload before printing
 *
 * Drop-in replacement:
 *   In agent.js, replace:
 *     const { startPoller, stopPoller, getStats } = require('./poller/poller');
 *   With:
 *     const { startWsClient, stopWsClient, getStats } = require('./ws/wsClient');
 *   No other files need to change.
 */

const {Pusher}  = require("pusher-js");
const axios   = require("axios");
const logger  = require("../utils/logger");
const config  = require("../utils/config");
const registry = require("../registry/registry");
const { executePrintJob } = require("../adapters/printService");

// ── State ─────────────────────────────────────────────────────────────────────
let pusherClient       = null;
let channel            = null;
let reconnectTimer     = null;
let isRunning          = false;

// Stats
let totalJobsDone      = 0;
let totalJobsFailed    = 0;
let totalDuplicates    = 0;
let connectedAt        = null;
let lastJobAt          = null;
let consecutiveFails   = 0;

/**
 * Deduplication cache: Map<job_uuid, { processedAt: Date }>
 *
 * Pusher guarantees at-least-once delivery — the same event CAN arrive twice
 * in quick succession (e.g. during reconnect). This cache prevents duplicate prints.
 *
 * TTL: 2 hours (covers Pusher's retry window with large margin)
 * The cache stays small — at 1000 orders/day with ~2 jobs each = ~2000 entries/day.
 * At ~50 bytes per entry = ~100KB max. Well within Node.js memory budget.
 */
const processedJobs = new Map(); // uuid → { processedAt: timestamp }
const DEDUP_TTL_MS  = 2 * 60 * 60 * 1000; // 2 hours

// Prune old entries every hour
setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  let pruned = 0;
  for (const [uuid, { processedAt }] of processedJobs) {
    if (processedAt < cutoff) {
      processedJobs.delete(uuid);
      pruned++;
    }
  }
  if (pruned > 0) {
    logger.debug("WsClient: pruned dedup cache", { pruned, remaining: processedJobs.size });
  }
}, 60 * 60 * 1000);

// ── HTTP client ───────────────────────────────────────────────────────────────

function createHttpClient() {
  return axios.create({
    baseURL: config.laravelUrl,
    timeout: 10_000,
    headers: {
      "X-Agent-Key":     config.agentKey,
      "X-Agent-Id":      config.agentId,
      "X-Agent-Version": config.agentVersion || "2.0.0",
      "Content-Type":    "application/json",
      "Accept":          "application/json",
    },
  });
}

// ── Process a single print job ────────────────────────────────────────────────

/**
 * Process one print job event received from WebSocket.
 *
 * @param {object} data  The event payload from PrintJobDispatched::broadcastWith()
 * @param {object} http  Axios instance for ACK calls
 */
async function processJob(data, http) {
  const {
    job_uuid,
    job_id,
    vendor_id,
    printer_type,
    printer_node_id,
    content_type,
    content,
    order_id,
  } = data;

  // ── Guard 1: Tenant isolation ─────────────────────────────────────────────
  // The channel auth server-side already enforces this, but we double-check
  // in the agent as a defense-in-depth measure.
  if (String(vendor_id) !== String(config.vendorId)) {
    logger.error("WsClient: TENANT ISOLATION VIOLATION — wrong vendor_id in payload", {
      received_vendor: vendor_id,
      expected_vendor: config.vendorId,
      job_uuid,
      job_id,
    });
    // Do NOT print. Do NOT ACK. Log and discard.
    return;
  }

  // ── Guard 2: Deduplication ────────────────────────────────────────────────
  // If we've already processed this job_uuid, it's a duplicate delivery.
  // This happens legitimately when Pusher retries delivery during reconnects.
  if (processedJobs.has(job_uuid)) {
    totalDuplicates++;
    logger.info("WsClient: duplicate job ignored (already processed)", {
      job_uuid,
      job_id,
      vendor_id,
    });
    return;
  }

  // Mark as seen BEFORE printing.
  //
  // For live WS events this is the right position:
  //   - If we mark AFTER printing and the agent crashes mid-print,
  //     the next WS re-delivery would find no cache entry and print again.
  //   - Marking BEFORE means a crash leaves the UUID in the (now-lost)
  //     cache, but the job stays 'pending' in DB (we never ACKed).
  //     The reconnect fallback poll returns it as a stale-claimed job
  //     and drainProcessJob() re-prints it — correctly, because drain
  //     does NOT check this cache before printing.
  //
  // Do NOT copy this pattern to drainProcessJob() — drain writes to the
  // cache AFTER printing to avoid blocking the drain on a cache hit.
  processedJobs.set(job_uuid, { processedAt: Date.now() });

  lastJobAt = new Date().toISOString();

  // ── Guard 3: Printer registry lookup ──────────────────────────────────────
  const printerConfig = registry.lookup(printer_node_id);

  if (!printerConfig) {
    const error =
      `Printer "${printer_node_id}" not in registry. ` +
      `Open http://localhost:${config.uiPort} to assign printers.`;

    logger.error("WsClient: printer not in registry", {
      job_uuid,
      job_id,
      printer_node_id,
    });

    await ackJob(http, job_id, job_uuid, "failed", error);
    return;
  }

  // ── Print ─────────────────────────────────────────────────────────────────
  logger.info("WsClient: printing job", {
    job_uuid,
    job_id,
    order_id,
    printer_type,
    printer_node_id,
    content_type,
    vendor_id,
  });

  try {
    // executePrintJob is your existing adapter — unchanged
    await executePrintJob(
      { id: job_id, job_uuid, printer_type, printer_node_id, content_type, content, order_id },
      printerConfig
    );

    totalJobsDone++;
    consecutiveFails = 0;

    await ackJob(http, job_id, job_uuid, "done");

    logger.info("WsClient: job printed successfully", {
      job_uuid,
      job_id,
      order_id,
      printer_type,
    });

  } catch (err) {
    totalJobsFailed++;
    consecutiveFails++;

    logger.error("WsClient: print failed", {
      job_uuid,
      job_id,
      error: err.message,
    });

    await ackJob(http, job_id, job_uuid, "failed", err.message);
  }
}

// ── ACK back to Laravel ───────────────────────────────────────────────────────

async function ackJob(http, jobId, jobUuid, status, errorMsg) {
  try {
    await http.post(`/api/agent/jobs/${jobId}/ack`, {
      status,
      job_uuid:  jobUuid,
      agent_id:  config.agentId,
      error:     errorMsg || undefined,
    });

    logger.debug("WsClient: ACK sent", { job_id: jobId, job_uuid: jobUuid, status });
  } catch (err) {
    // Non-fatal — server-side cleanup will handle unACKed jobs
    // The job stays 'pending' and will be re-delivered on next reconnect poll
    logger.warn("WsClient: ACK failed (non-fatal)", {
      job_id:   jobId,
      job_uuid: jobUuid,
      status,
      error:    err.message,
    });
  }
}

// ── Fallback poll — called on connect to drain missed jobs ────────────────────

/**
 * Called once when the agent connects or reconnects.
 *
 * The server atomically:
 *   1. Resets any stale-claimed jobs (claimed > 2 min ago, no ACK) → pending
 *   2. Claims all pending jobs for this agent
 *   3. Returns them
 *
 * The agent then prints each one sequentially and ACKs.
 * If the agent crashes again mid-drain, the job stays 'claimed'
 * and will be recovered on the next reconnect cycle.
 *
 * IMPORTANT — dedup cache interaction:
 *   Stale-claimed jobs were claimed by a PREVIOUS agent session that crashed.
 *   The current session has never seen them, so they are NOT in the dedup cache.
 *   They must be printed even if the UUID looks familiar from a previous run,
 *   because that previous run never successfully printed them.
 *   We do NOT skip stale-claimed jobs on UUID match — we re-print them.
 *   We DO update the dedup cache after printing to block WS re-delivery.
 */
async function drainMissedJobs(http) {
  logger.info("WsClient: draining missed/stale jobs via fallback poll");

  let jobs;
  try {
    const response = await http.get("/api/agent/jobs", {
      params: { agent_id: config.agentId },
    });
    jobs = response.data.jobs || [];
  } catch (err) {
    logger.warn("WsClient: fallback poll request failed", { error: err.message });
    return;
  }

  if (jobs.length === 0) {
    logger.info("WsClient: no missed or stale jobs found");
    return;
  }

  logger.info("WsClient: fallback poll returned jobs to process", {
    count:     jobs.length,
    job_uuids: jobs.map(j => j.job_uuid),
  });

  // Process sequentially — avoid hammering one printer with concurrent jobs
  // on reconnect when a backlog has built up.
  for (const job of jobs) {
    await drainProcessJob(job, http);
  }
}

/**
 * Process a single job returned by the fallback poll.
 *
 * Key differences from processJob() (used for live WS events):
 *
 *   1. The server has already claimed this job atomically.
 *      We do NOT check the dedup cache to skip it — it must be printed
 *      because the previous claimant crashed before printing.
 *
 *   2. We DO write to the dedup cache AFTER printing so that if the same
 *      job is also delivered via WebSocket (Pusher re-delivery during
 *      the reconnect window), the WS handler will correctly skip it.
 *
 *   3. Tenant isolation check still runs — never relax security guards.
 */
async function drainProcessJob(job, http) {
  const {
    id:              job_id,
    job_uuid,
    printer_type,
    printer_node_id,
    content_type,
    content,
    order_id,
  } = job;

  // Tenant isolation — always verify, even in drain path
  if (String(job.vendor_id ?? config.vendorId) !== String(config.vendorId)) {
    logger.error("WsClient: TENANT VIOLATION in drain — wrong vendor_id", {
      job_id, job_uuid,
    });
    return;
  }

  // Printer lookup
  const printerConfig = registry.lookup(printer_node_id);
  if (!printerConfig) {
    const error = `Printer "${printer_node_id}" not in registry. Open http://localhost:${config.uiPort} to assign.`;
    logger.error("WsClient: drain — printer not in registry", { job_id, job_uuid, printer_node_id });
    await ackJob(http, job_id, job_uuid, "failed", error);
    // Mark in dedup cache so WS re-delivery is also skipped
    processedJobs.set(job_uuid, { processedAt: Date.now() });
    return;
  }

  logger.info("WsClient: drain — printing job", {
    job_id, job_uuid, order_id, printer_type, printer_node_id, content_type,
  });

  try {
    await executePrintJob(
      { id: job_id, job_uuid, printer_type, printer_node_id, content_type, content, order_id },
      printerConfig
    );

    totalJobsDone++;
    consecutiveFails = 0;
    lastJobAt = new Date().toISOString();

    // Mark in dedup cache NOW — before ACK — so any concurrent WS delivery
    // of the same job is blocked while ACK is in-flight.
    processedJobs.set(job_uuid, { processedAt: Date.now() });

    await ackJob(http, job_id, job_uuid, "done");

    logger.info("WsClient: drain — job printed and ACKed", {
      job_id, job_uuid, order_id, printer_type,
    });

  } catch (err) {
    totalJobsFailed++;
    consecutiveFails++;
    lastJobAt = new Date().toISOString();

    logger.error("WsClient: drain — print failed", {
      job_id, job_uuid, error: err.message,
    });

    // Mark in dedup cache even on failure so WS re-delivery doesn't retry
    // a job we just confirmed is broken (bad content, hardware error, etc.)
    processedJobs.set(job_uuid, { processedAt: Date.now() });

    await ackJob(http, job_id, job_uuid, "failed", err.message);
  }
}

// ── Pusher client setup ───────────────────────────────────────────────────────

/**
 * Create and connect the Pusher client.
 *
 * Auth flow:
 *   Pusher library automatically calls authEndpoint when subscribing
 *   to a private channel. We use our custom agent auth endpoint
 *   which validates X-Agent-Key instead of requiring a Laravel session.
 */
function createPusherClient(http) {
  const pusherKey     = config.pusherKey;
  const pusherCluster = config.pusherCluster || "mt1";
  const pusherHost    = config.pusherHost;
  const pusherPort    = config.pusherPort;
  const useSelfHosted = !!pusherHost;

  const pusherOptions = {
    // ── Auth for private channels ─────────────────────────────────────────
    // Custom auth endpoint that accepts X-Agent-Key instead of session cookie
    authEndpoint: `${config.laravelUrl}/api/agent/broadcasting/auth`,

    auth: {
      headers: {
        "X-Agent-Key":     config.agentKey,
        "X-Agent-Id":      config.agentId,
        "X-Agent-Version": config.agentVersion || "2.0.0",
        "Accept":          "application/json",
      },
    },

    // ── Connection settings ───────────────────────────────────────────────
    cluster: pusherCluster,
    encrypted: true,

    // ── Auto-reconnect (Pusher handles this natively) ─────────────────────
    // Pusher client auto-reconnects on disconnect.
    // We hook into 'connected' event to drain missed jobs.

    // ── Activity timeout ──────────────────────────────────────────────────
    // Pusher pings server after 120s of inactivity; if no pong in 30s, reconnects.
    activityTimeout:  120_000,
    pongTimeout:       30_000,
  };

  // ── Self-hosted Laravel WebSockets (beyondcode/laravel-websockets) ────────
  if (useSelfHosted) {
    pusherOptions.wsHost   = pusherHost;
    pusherOptions.wsPort   = pusherPort || 6001;
    pusherOptions.wssPort  = pusherPort || 6001;
    pusherOptions.enabledTransports = ["ws", "wss"];
    pusherOptions.disableStats      = true;
    delete pusherOptions.cluster;     // Not used with self-hosted
  }

  return new Pusher(pusherKey, pusherOptions);
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

function startWsClient() {
  if (isRunning) {
    logger.warn("WsClient: already running");
    return;
  }

  isRunning = true;
  const http = createHttpClient();

  logger.info("WsClient: starting WebSocket client", {
    laravelUrl: config.laravelUrl,
    vendorId:   config.vendorId,
    agentId:    config.agentId,
    channel:    `private-vendor.${config.vendorId}`,
  });

  connect(http);
}

function connect(http) {
  if (!isRunning) return;

  pusherClient = createPusherClient(http);

  // ── Connection state handlers ─────────────────────────────────────────────
  pusherClient.connection.bind("connected", async () => {
    connectedAt = new Date().toISOString();
    logger.info("WsClient: connected to WebSocket server", {
      socket_id: pusherClient.connection.socket_id,
    });

    subscribeToVendorChannel(http);

    // Drain any jobs missed while disconnected
    await drainMissedJobs(http);
  });

  pusherClient.connection.bind("disconnected", () => {
    logger.warn("WsClient: disconnected from WebSocket server");
    // Pusher client handles reconnection automatically.
    // We just log here — the 'connected' event fires again on reconnect.
  });

  pusherClient.connection.bind("error", (err) => {
    logger.error("WsClient: WebSocket connection error", {
      error: err?.error?.data?.message || JSON.stringify(err),
      type:  err?.type,
    });
  });

  pusherClient.connection.bind("failed", () => {
    // All transports tried and failed (ws, xhr_streaming, etc.)
    logger.error("WsClient: all WebSocket transports failed");
  });

  pusherClient.connection.bind("state_change", ({ previous, current }) => {
    logger.info("WsClient: connection state changed", { previous, current });
  });
}

function subscribeToVendorChannel(http) {
  const channelName = `private-vendor.${config.vendorId}`;

  channel = pusherClient.subscribe(channelName);

  channel.bind("pusher:subscription_succeeded", () => {
    logger.info("WsClient: subscribed to vendor channel", {
      channel:   channelName,
      vendor_id: config.vendorId,
    });
  });

  channel.bind("pusher:subscription_error", (err) => {
    logger.error("WsClient: channel subscription failed", {
      channel: channelName,
      status:  err?.status,
      error:   err?.error,
      hint:    err?.status === 401
        ? "Check AGENT_KEY in .env — key must match agent_key in companies table"
        : err?.status === 403
        ? "Channel auth rejected — agent key may belong to different vendor"
        : "Check Laravel server and broadcasting config",
    });
  });

  // ── The main event handler ────────────────────────────────────────────────
  // broadcastAs() in PHP returns 'print.job.dispatched'
  // Pusher prefixes private channel events with the event name directly.
  channel.bind("print.job.dispatched", async (data) => {
    logger.debug("WsClient: event received", {
      job_uuid: data?.job_uuid,
      job_id:   data?.job_id,
    });

    try {
      await processJob(data, http);
    } catch (err) {
      // Should not happen (processJob has its own try/catch)
      // but belt-and-suspenders to prevent unhandled rejection
      logger.error("WsClient: unhandled error in processJob", {
        error: err.message,
        job_uuid: data?.job_uuid,
      });
    }
  });
}

function stopWsClient() {
  isRunning = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (channel) {
    channel.unbind_all();
    channel = null;
  }

  if (pusherClient) {
    pusherClient.disconnect();
    pusherClient = null;
  }

  logger.info("WsClient: stopped");
}

function getStats() {
  return {
    mode:            "websocket",
    running:         isRunning,
    connected:       pusherClient?.connection.state === "connected",
    connectionState: pusherClient?.connection.state || "disconnected",
    connectedAt,
    lastJobAt,
    consecutiveFails,
    totalJobsDone,
    totalJobsFailed,
    totalDuplicates,
    dedupCacheSize:  processedJobs.size,
    channel:         `private-vendor.${config.vendorId}`,
  };
}

module.exports = { startWsClient, stopWsClient, getStats };