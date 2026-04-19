"use strict";

/**
 * poller.js — DB polling transport (replaces wsClient.js for testing)
 *
 * Every POLL_INTERVAL_MS (default 3s):
 *   GET /api/agent/jobs  → Laravel returns pending jobs for this vendor
 *   For each job:
 *     - Look up printer in registry
 *     - Execute print (raw_base64 ESC/POS or pdf_base64 PDF)
 *     - POST /api/agent/jobs/{id}/ack  → report done or failed
 *
 * Handles content_type:
 *   raw_base64  → Buffer.from(content, 'base64') → TCP port 9100
 *   pdf_base64  → Buffer.from(content, 'base64') → TCP port 9100 or CUPS
 *
 * To switch back to WebSocket later:
 *   In agent.js replace startPoller/stopPoller with startWebSocket/stopWebSocket
 *   No other files need to change.
 */

const axios    = require("axios");
const logger   = require("../utils/logger");
const config   = require("../utils/config");
const registry = require("../registry/registry");
const { executePrintJob } = require("../adapters/printService");

// ── State ─────────────────────────────────────────────────────────────────────
let pollTimer         = null;
let isPolling         = false;
let consecutiveFails  = 0;
let totalJobsDone     = 0;
let totalJobsFailed   = 0;
let lastPollAt        = null;
let lastSuccessAt     = null;

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

// ── Process a single job ──────────────────────────────────────────────────────
async function processJob(job, http) {
  const maxAttempts = config.jobRetryAttempts || 3;
  const retryDelay  = config.jobRetryDelayMs  || 5000;

  // Look up printer config from local registry
  const printerConfig = registry.lookup(job.printer_node_id);

  if (!printerConfig) {
    const error =
      `Printer "${job.printer_node_id}" not found in local registry. ` +
      `Open http://localhost:${config.uiPort} to assign printers.`;

    logger.error("Poller: printer not in registry", {
      jobId:     job.id,
      printerId: job.printer_node_id,
    });

    await ackJob(http, job.id, "failed", error);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info("Poller: printing job", {
        jobId:       job.id,
        orderId:     job.order_id,
        printerId:   job.printer_node_id,
        printerType: job.printer_type,
        contentType: job.content_type,
        attempt,
      });

      await executePrintJob(job, printerConfig);
      await ackJob(http, job.id, "done");
      totalJobsDone++;

      logger.info("Poller: job done", {
        jobId:    job.id,
        orderId:  job.order_id,
        attempt,
      });
      return;

    } catch (err) {
      lastError = err.message;
      logger.warn("Poller: print attempt failed", {
        jobId:   job.id,
        attempt,
        maxAttempts,
        error:   err.message,
      });
      if (attempt < maxAttempts) {
        await sleep(retryDelay * attempt);
      }
    }
  }

  // All attempts exhausted
  totalJobsFailed++;
  await ackJob(http, job.id, "failed", lastError);
  logger.error("Poller: job failed after all retries", {
    jobId:   job.id,
    orderId: job.order_id,
    error:   lastError,
  });
}

// ── ACK a job back to Laravel ─────────────────────────────────────────────────
async function ackJob(http, jobId, status, errorMsg) {
  try {
    await http.post(`/api/agent/jobs/${jobId}/ack`, {
      status,
      error: errorMsg || undefined,
    });
  } catch (err) {
    // Non-fatal — Laravel cleanup job will handle stale claimed rows
    logger.warn("Poller: ack failed (non-fatal)", {
      jobId,
      status,
      error: err.message,
    });
  }
}

// ── Single poll cycle ─────────────────────────────────────────────────────────
async function doPoll(http) {
  lastPollAt = new Date().toISOString();

  let jobs;
  try {
    const response = await http.get("/api/agent/jobs", {
      params: { agent_id: config.agentId },
    });
    jobs = response.data.jobs || [];
    consecutiveFails = 0;
    lastSuccessAt    = new Date().toISOString();
  } catch (err) {
    consecutiveFails++;

    // Auth failure — wrong key, stop polling
    if (err.response?.status === 401) {
      logger.error("Poller: agent key rejected — check AGENT_KEY in .env", {
        status: 401,
        url:    config.laravelUrl,
      });
      stopPoller();
      return;
    }

    // Log first fail and every 10th after that to avoid log spam
    if (consecutiveFails === 1 || consecutiveFails % 10 === 0) {
      logger.warn("Poller: cannot reach Laravel", {
        consecutiveFails,
        error:  err.message,
        status: err.response?.status,
      });
    }
    return;
  }

  if (jobs.length === 0) return;

  logger.info("Poller: jobs received", {
    count: jobs.length,
    ids:   jobs.map(j => j.id),
  });

  // Process up to maxConcurrentJobs in parallel
  const maxConcurrent = config.maxConcurrentJobs || 3;
  for (let i = 0; i < jobs.length; i += maxConcurrent) {
    const chunk = jobs.slice(i, i + maxConcurrent);
    await Promise.allSettled(chunk.map(job => processJob(job, http)));
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────
function startPoller() {
  if (pollTimer) {
    logger.warn("Poller: already running");
    return;
  }

  const http     = createHttpClient();
  const interval = config.pollIntervalMs || 3000;

  logger.info("Poller: started (DB polling mode)", {
    laravelUrl: config.laravelUrl,
    vendorId:   config.vendorId,
    agentId:    config.agentId,
    interval:   `${interval}ms`,
  });

  // Run immediately on start then on interval
  doPoll(http);

  pollTimer = setInterval(() => {
    if (!isPolling) {
      isPolling = true;
      doPoll(http).finally(() => { isPolling = false; });
    }
  }, interval);
}

function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info("Poller: stopped");
  }
}

function getStats() {
  return {
    mode:            "polling",
    running:         !!pollTimer,
    lastPollAt,
    lastSuccessAt,
    consecutiveFails,
    totalJobsDone,
    totalJobsFailed,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startPoller, stopPoller, getStats };