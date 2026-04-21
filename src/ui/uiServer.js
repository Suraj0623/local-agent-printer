"use strict";

/**
 * uiServer.js — Phase 3 (multi-source discovery) + WebSocket Monitor
 *
 * Express server on localhost:3001 (never exposed to internet).
 *
 * API routes:
 *   GET  /api/config           → current agent config status
 *   POST /api/config           → save agent config to .env
 *   GET  /api/scan             → LAN scan (accepts ?extraPorts=9103,9200)
 *   GET  /api/scan/os          → OS printer discovery
 *   GET  /api/scan/usb         → USB device enumeration
 *   POST /api/probe            → manual connectivity test { ip, port }
 *   GET  /api/ports            → return default + user-defined port list
 *   POST /api/test-print       → send ESC/POS test page { ip, port, label }
 *   POST /api/assign           → assign printer role → generate ID
 *   GET  /api/printers         → list current assignments
 *   DELETE /api/printers/:id   → remove an assignment
 *   GET  /api/verify-laravel   → test Laravel connectivity with saved key
 */

const express  = require("express");
const path     = require("path");
const fs       = require("fs");
const axios    = require("axios");
const logger   = require("../utils/logger");
const config   = require("../utils/config");
const { attachStatusMonitor } = require("./statusMonitor");
const {
  scanAllNetworks,
  discoverOsPrinters,
  discoverUsbDevices,
  probeSpecific,
  sendTestPrint,
  DEFAULT_PORTS,
} = require("../scanner/scanner");

const registry = require("../registry/registry");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Attach the WebSocket status monitor dashboard and API endpoints
attachStatusMonitor(app);

// ── GET /api/config ──────────────────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  const laravelUrl = process.env.LARAVEL_URL || "";
  const agentKey   = process.env.AGENT_KEY   || "";
  const vendorId   = process.env.VENDOR_ID   || "";
  const agentId    = process.env.AGENT_ID    || "";

  res.json({
    configured:     !!(laravelUrl && agentKey && vendorId),
    laravelUrl,
    agentKeySet:    agentKey.length > 4,
    agentKeyMasked: agentKey
      ? agentKey.slice(0, 4) + "****" + agentKey.slice(-4)
      : "",
    vendorId,
    agentId,
    suggestedIds: registry.getSuggestedIds(parseInt(vendorId) || 0),
  });
});

// ── POST /api/config ─────────────────────────────────────────────────────────
app.post("/api/config", (req, res) => {
  const { laravelUrl, agentKey, vendorId, agentId } = req.body;

  if (!laravelUrl || !agentKey || !vendorId) {
    return res.status(422).json({
      error: "laravelUrl, agentKey, and vendorId are required",
    });
  }

  const envContent = [
    `LARAVEL_URL=${laravelUrl.replace(/\/$/, "")}`,
    `AGENT_KEY=${agentKey}`,
    `VENDOR_ID=${vendorId}`,
    `AGENT_ID=${agentId || "print-agent"}`,
    `POLL_INTERVAL_MS=${process.env.POLL_INTERVAL_MS || 2000}`,
    `UI_PORT=${process.env.UI_PORT || 3001}`,
    `LOG_LEVEL=${process.env.LOG_LEVEL || "info"}`,
    `LOG_DIR=${process.env.LOG_DIR || "./logs"}`,
  ].join("\n");

  try {
    fs.writeFileSync(path.resolve(process.cwd(), ".env"), envContent, "utf8");
    process.env.LARAVEL_URL = laravelUrl.replace(/\/$/, "");
    process.env.AGENT_KEY   = agentKey;
    process.env.VENDOR_ID   = vendorId;
    process.env.AGENT_ID    = agentId || "print-agent";

    logger.info("UI: config saved", { laravelUrl, vendorId, agentId });

    res.json({
      ok:          true,
      message:     "Config saved. Restart the agent to apply changes.",
      suggestedIds: registry.getSuggestedIds(parseInt(vendorId)),
    });
  } catch (err) {
    logger.error("UI: failed to save config", { error: err.message });
    res.status(500).json({ error: "Failed to write .env: " + err.message });
  }
});

// ── GET /api/scan ─────────────────────────────────────────────────────────────
// ?extraPorts=9103,9200  (comma-separated)
app.get("/api/scan", async (req, res) => {
  const extraPortsParam = req.query.extraPorts || "";
  const extraPorts = extraPortsParam
    ? extraPortsParam.split(",").map(Number).filter(n => n > 0 && n < 65536)
    : [];

  logger.info("UI: LAN scan requested", { extraPorts });

  try {
    const devices  = await scanAllNetworks(extraPorts);
    const existing = registry.list();

    const enriched = devices.map(d => {
      const assignment = existing.find(e => e.ip === d.ip);
      return {
        ...d,
        assigned:  !!assignment,
        role:      assignment?.role      || null,
        printerId: assignment?.id        || null,
        label:     assignment?.label     || null,
      };
    });

    res.json({ devices: enriched, total: enriched.length });
  } catch (err) {
    logger.error("UI: LAN scan failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/scan/os ──────────────────────────────────────────────────────────
app.get("/api/scan/os", async (req, res) => {
  logger.info("UI: OS printer discovery requested");

  try {
    const devices  = await discoverOsPrinters();
    const existing = registry.list();

    const enriched = devices.map(d => {
      const assignment = existing.find(
        e => e.os_name === d.osPrinterName || (d.ip && e.ip === d.ip)
      );
      return {
        ...d,
        assigned:  !!assignment,
        role:      assignment?.role  || null,
        printerId: assignment?.id    || null,
        label:     assignment?.label || null,
      };
    });

    res.json({ devices: enriched, total: enriched.length });
  } catch (err) {
    logger.error("UI: OS discovery failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/scan/usb ─────────────────────────────────────────────────────────
app.get("/api/scan/usb", async (req, res) => {
  logger.info("UI: USB device discovery requested");

  try {
    const devices  = await discoverUsbDevices();
    const existing = registry.list();

    const enriched = devices.map(d => {
      const assignment = existing.find(e => e.usb_path === d.usbPath || e.device === d.usbPath);
      return {
        ...d,
        assigned:  !!assignment,
        role:      assignment?.role  || null,
        printerId: assignment?.id    || null,
        label:     assignment?.label || null,
      };
    });

    res.json({ devices: enriched, total: enriched.length });
  } catch (err) {
    logger.error("UI: USB discovery failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/probe ───────────────────────────────────────────────────────────
app.post("/api/probe", async (req, res) => {
  const { ip, port } = req.body;

  if (!ip || !port) {
    return res.status(422).json({ error: "ip and port are required" });
  }

  logger.info("UI: manual probe requested", { ip, port });

  const result = await probeSpecific(ip, parseInt(port, 10));
  res.json(result);
});

// ── GET /api/ports ────────────────────────────────────────────────────────────
app.get("/api/ports", (req, res) => {
  const userPorts = (process.env.EXTRA_SCAN_PORTS || "")
    .split(",")
    .map(Number)
    .filter(n => n > 0 && n < 65536);

  res.json({
    defaults:    DEFAULT_PORTS,
    userDefined: userPorts,
    all:         [...new Set([...DEFAULT_PORTS, ...userPorts])],
  });
});

// ── POST /api/test-print ──────────────────────────────────────────────────────
app.post("/api/test-print", async (req, res) => {
  const { ip, port, label } = req.body;

  if (!ip || !port) {
    return res.status(422).json({ error: "ip and port required" });
  }

  logger.info("UI: test print requested", { ip, port });

  try {
    await sendTestPrint(ip, parseInt(port, 10), label || "Test Page");
    res.json({ ok: true, message: `Test page sent to ${ip}:${port}` });
  } catch (err) {
    logger.warn("UI: test print failed", { ip, port, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/assign ──────────────────────────────────────────────────────────
app.post("/api/assign", (req, res) => {
  const {
    role, ip, port, label,
    connection, device,
    osPrinterName, cupsName, windowsPrinterName,
    ports: scannedPorts,
    printerType: printerTypeOverride,   // "pos" | "a4" — explicit user override
  } = req.body;

  const vendorId = parseInt(process.env.VENDOR_ID || config.vendorId, 10);

  if (!role) {
    return res.status(422).json({ error: "role is required (main|kitchen|standard)" });
  }

  // Validate override value if supplied
  if (printerTypeOverride && !["pos", "a4"].includes(printerTypeOverride)) {
    return res.status(422).json({ error: "printerType must be \"pos\" or \"a4\"" });
  }

  try {
    let result;

    if (connection === "usb" || connection === "usb_raw") {
      if (!device) return res.status(422).json({ error: "device path required for USB printers" });
      result = registry.assignUsb(role, device, label, vendorId);

    } else if (connection === "cups" || connection === "ipp") {
      const name = cupsName || osPrinterName;
      if (!name) return res.status(422).json({ error: "cupsName required for CUPS printers" });
      result = registry.assignCups(role, name, label, vendorId, ip || null, printerTypeOverride || null);

    } else if (connection === "winspooler" || connection === "driver") {
      const name = windowsPrinterName || osPrinterName;
      if (!name) return res.status(422).json({ error: "windowsPrinterName required for Windows printers" });
      result = registry.assignWindowsSpooler(role, name, label, vendorId, ip || null, printerTypeOverride || null);

    } else {
      // Default: network / raw
      if (!ip || !port) return res.status(422).json({ error: "ip and port required for network printers" });
      result = registry.assign(
        role, ip, parseInt(port, 10), label, vendorId,
        { ports: scannedPorts || [parseInt(port, 10)], printerTypeOverride: printerTypeOverride || null }
      );
    }

    logger.info("UI: printer assigned", {
      printerId: result.printerId, role,
      ip: ip || device || osPrinterName,
      printerType: result.config.printer_type,
    });

    res.status(201).json({
      ok:        true,
      printerId: result.printerId,
      config:    result.config,
      message:   `Copy "${result.printerId}" into the Laravel ${roleToFieldName(role)} field`,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ── GET /api/printers ─────────────────────────────────────────────────────────
app.get("/api/printers", (req, res) => {
  const vendorId  = parseInt(process.env.VENDOR_ID || config.vendorId, 10);
  const printers  = registry.list();
  const suggested = registry.getSuggestedIds(vendorId);

  res.json({
    vendorId,
    printers,
    suggestedIds: suggested,
    laravelFields: {
      "Main thermal printer ID (print_node_main_thermal_id)":       suggested.main_thermal,
      "Kitchen thermal printer ID (print_node_kitchen_thermal_id)": suggested.kitchen_thermal,
      "Standard printer ID (print_node_standard_id)":               suggested.standard_a4,
    },
  });
});

// ── DELETE /api/printers/:id ──────────────────────────────────────────────────
app.delete("/api/printers/:id", (req, res) => {
  const removed = registry.remove(req.params.id);
  if (removed) {
    res.json({ ok: true, message: `Printer ${req.params.id} removed` });
  } else {
    res.status(404).json({ error: "Printer not found" });
  }
});

// ── GET /api/verify-laravel ───────────────────────────────────────────────────
app.get("/api/verify-laravel", async (req, res) => {
  const laravelUrl = process.env.LARAVEL_URL;
  const agentKey   = process.env.AGENT_KEY;

  if (!laravelUrl || !agentKey) {
    return res.status(422).json({
      ok:    false,
      error: "Config not saved yet. Fill in the form and save first.",
    });
  }

  try {
    const response = await axios.get(`${laravelUrl}/api/agent/status`, {
      headers: { "X-Agent-Key": agentKey },
      timeout: 8000,
    });
    const data = response.data;

    res.json({
      ok:         true,
      vendorId:   data.vendor_id,
      vendorName: data.vendor_name,
      printerIds: data.printer_ids,
      message:    `Connected to ${data.vendor_name} (vendor #${data.vendor_id})`,
    });
  } catch (err) {
    const status  = err.response?.status;
    const message = status === 401
      ? "Agent key rejected — check the key matches Laravel"
      : `Cannot reach ${laravelUrl} — check the URL and network`;

    logger.warn("UI: Laravel verify failed", { error: err.message, status });
    res.status(400).json({ ok: false, error: message, detail: err.message });
  }
});
// ── GET /api/platform ────────────────────────────────────────────────────────
app.get('/api/platform', (req, res) => {
  res.json({ 
    platform: process.platform,  // 'win32', 'linux', 'darwin'
    arch: process.arch,
    nodeVersion: process.version
  });
});
// ── Start server ──────────────────────────────────────────────────────────────
function startUiServer(port) {
  port = port || config.uiPort || 3001;
  app.listen(port, "127.0.0.1", () => {
    logger.info(`UI server started on http://localhost:${port}`);
    console.log(`\n  Setup wizard: http://localhost:${port}\n`);
  });
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function roleToFieldName(role) {
  return { main: "Main thermal printer ID", kitchen: "Kitchen thermal printer ID", standard: "Standard printer ID" }[role] || role;
}

module.exports = { startUiServer };