"use strict";

require("dotenv").config();

function getRequired(key) {
  const val = process.env[key];
  if (!val || val.trim() === "" || val.includes("paste-your")) {
    throw new Error(
      `Missing required config: ${key}\n` +
      `Run the setup wizard: open http://localhost:${process.env.UI_PORT || 3001}`
    );
  }
  return val.trim();
}

function get(key, defaultValue) {
  return (process.env[key] || String(defaultValue)).trim();
}

const isSetupMode = process.argv.includes("--setup") || !process.env.AGENT_KEY;

const config = {
  // Laravel server
  laravelUrl:   isSetupMode ? "" : getRequired("LARAVEL_URL").replace(/\/$/, ""),
  agentKey:     isSetupMode ? "" : getRequired("AGENT_KEY"),
  vendorId:     isSetupMode ? 0  : parseInt(getRequired("VENDOR_ID"), 10),

  // Agent identity
  agentId:      get("AGENT_ID", "print-agent"),
  agentVersion: "1.0.0",

  // Polling interval (ms) — how often to ask Laravel for pending jobs
  pollIntervalMs: parseInt(get("POLL_INTERVAL_MS", "3000"), 10),

  // Local UI
  uiPort: parseInt(get("UI_PORT", "3001"), 10),

  // Logging
  logLevel: get("LOG_LEVEL", "info"),
  logDir:   get("LOG_DIR", "./logs"),

  // Paths
  printersJsonPath: get("PRINTERS_JSON", "./config/printers.json"),

  // Print job settings
  maxConcurrentJobs: parseInt(get("MAX_CONCURRENT_JOBS", "3"), 10),
  jobRetryAttempts:  parseInt(get("JOB_RETRY_ATTEMPTS", "3"), 10),
  jobRetryDelayMs:   parseInt(get("JOB_RETRY_DELAY_MS", "5000"), 10),

  // Printer connection timeouts
  printerConnectTimeoutMs: parseInt(get("PRINTER_CONNECT_TIMEOUT_MS", "5000"), 10),
  printerWriteTimeoutMs:   parseInt(get("PRINTER_WRITE_TIMEOUT_MS",   "8000"), 10),

  // Scanner
  scanTimeoutMs: parseInt(get("SCAN_TIMEOUT_MS", "300"), 10),
  scanPort:      parseInt(get("SCAN_PORT", "9100"), 10),

  isSetupMode,
};

module.exports = config;