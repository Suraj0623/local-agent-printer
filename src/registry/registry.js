"use strict";

/**
 * registry.js — Phase 3 (multi-source, classified)
 *
 * Stores and classifies printer assignments.
 * Persisted to config/printers.json.
 *
 * Connection type classification:
 *   raw       → ports 9100–9102 (ESC/POS thermal)
 *   ipp       → port 631 (IPP / CUPS network)
 *   lpd       → port 515 (LPD legacy)
 *   driver    → OS-managed printer (Windows spooler / CUPS queue)
 *   usb_raw   → /dev/usb/lpX direct write
 *
 * Printer type:
 *   pos → raw / usb_raw connection  (ESC/POS content)
 *   a4  → ipp / lpd / driver        (PDF content)
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");
const config = require("../utils/config");

const JSON_PATH = path.resolve(config.printersJsonPath || "./config/printers.json");

// In-memory store  Map<printerId, printerConfig>
const store = new Map();

// ── Role → Laravel field mapping ─────────────────────────────────────────────

const ROLES = {
  "main":     "main_thermal",
  "kitchen":  "kitchen_thermal",
  "standard": "standard_a4",
};

// ── Port → connection type classification ────────────────────────────────────

const PORT_CONNECTION_TYPE = {
  9100: "raw",
  9101: "raw",
  9102: "raw",
  515:  "lpd",
  631:  "ipp",
};

/**
 * Thermal/POS printer name keywords.
 * When a printer is OS-discovered and its name matches any of these,
 * it is classified as pos/driver instead of a4/driver.
 */
const THERMAL_NAME_PATTERNS = [
  /\bTM[-_]?\w/i,
  /\bTSP\d/i,
  /\bBSC\d/i,
  /\bBixolon\b/i,
  /\bSRP[-_]?\d/i,
  /\bSP[-_]?\d{3}/i,
  /\bCT[-_]S\d/i,
  /\bCBM\d/i,
  /\bRP[-_]?\d{2}/i,
  /\bMP[-_]?T\d/i,
  /\bXP[-_]?\d{2}/i,
  /\bPOS[-_]?\d/i,
  /\b80[Cc]\b/,
  /\b58[Cc]\b/,
  /\bthermal\b/i,
  /\breceipt\b/i,
  /\bkitchen\b/i,
  /\bKOT\b/,
  /\bESC[\/-]?POS\b/i,
  /\b(80|58)\s*mm\b/i,
];

/**
 * Return true if the OS printer name looks like a thermal/POS printer.
 * @param {string} name
 */
function _looksLikeThermal(name) {
  if (!name) return false;
  return THERMAL_NAME_PATTERNS.some(re => re.test(name));
}

/**
 * Classify a discovered device into connection_type and printer_type.
 *
 * Priority order:
 *   1. Explicit USB path            → usb_raw / inferred from name (or pos if unknown)
 *   2. OS source + thermal name     → driver  / pos
 *   3. OS source (generic)          → driver  / a4
 *   4. LAN open ports               → raw|ipp|lpd / pos|a4
 *   5. Fallback                     → raw / pos
 *
 * KEY FIX: USB devices with an osPrinterName (populated by scanner's Get-Printer
 * join on Windows) now use name-based thermal detection instead of blindly
 * defaulting to "pos". e.g. USB001 → "Canon LBP2900" → a4, not pos.
 *
 * @param {object} device  unified scanner output
 * @param {string} [printerTypeOverride]  "pos" | "a4" — explicit user choice
 * @returns {{ connection_type: string, printer_type: string }}
 */
function classifyDevice(device, printerTypeOverride) {
  // ── 1. Explicit USB device path ───────────────────────────────────────────
  if (device.usbPath && device.source === "usb") {
    // If the USB port has an associated printer name (populated by scanner.js
    // via Get-Printer join on Windows), use name-based thermal detection.
    // Fall back to "pos" only when the printer name is completely unknown.
    const inferredType = device.osPrinterName
      ? (_looksLikeThermal(device.osPrinterName) ? "pos" : "a4")
      : "pos";  // no name info → assume thermal (safe default for bare USB ports)

    return {
      connection_type: "usb_raw",
      printer_type:    printerTypeOverride || inferredType,
    };
  }

  // ── 2 & 3. OS-managed (spooler / CUPS queue) ──────────────────────────────
  if (device.source === "os" || device.osPrinterName) {
    const inferredType = _looksLikeThermal(device.osPrinterName) ? "pos" : "a4";
    return {
      connection_type: "driver",
      printer_type:    printerTypeOverride || inferredType,
    };
  }

  // ── 4. LAN: classify by open ports ───────────────────────────────────────
  if (device.ports && device.ports.length) {
    const openPorts = device.ports;

    if (openPorts.some(p => p === 631)) {
      return { connection_type: "ipp", printer_type: printerTypeOverride || "a4" };
    }
    if (openPorts.some(p => p === 515)) {
      return { connection_type: "lpd", printer_type: printerTypeOverride || "a4" };
    }
    if (openPorts.some(p => [9100, 9101, 9102].includes(p))) {
      return { connection_type: "raw", printer_type: printerTypeOverride || "pos" };
    }
  }

  // ── 5. Fallback ───────────────────────────────────────────────────────────
  return { connection_type: "raw", printer_type: printerTypeOverride || "pos" };
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk() {
  try {
    if (!fs.existsSync(JSON_PATH)) {
      logger.info("Registry: no printers.json found — starting empty");
      return;
    }
    const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    for (const [id, cfg] of Object.entries(data.printers || {})) {
      store.set(id, cfg);
    }
    logger.info("Registry: loaded from disk", {
      path:     JSON_PATH,
      count:    store.size,
      printers: [...store.keys()],
    });
  } catch (err) {
    logger.error("Registry: failed to load printers.json", { error: err.message });
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
    const data = { printers: Object.fromEntries(store) };
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), "utf8");
    logger.debug("Registry: saved to disk", { path: JSON_PATH });
  } catch (err) {
    logger.error("Registry: failed to save printers.json", { error: err.message });
  }
}

// ── Internal: build & store a printer config ──────────────────────────────────

function _store(printerId, fields) {
  const cfg = {
    id:         printerId,
    assignedAt: new Date().toISOString(),
    ...fields,
  };
  store.set(printerId, cfg);
  saveToDisk();
  logger.info("Registry: printer assigned", { printerId, ...fields });
  return { printerId, config: cfg };
}

// ── Public API ────────────────────────────────────────────────────────────────

function assign(role, ip, port, label, vendorId, deviceHints = {}) {
  if (!ROLES[role]) throw new Error(`Invalid role "${role}". Must be: ${Object.keys(ROLES).join(", ")}`);
  if (!ip || !port) throw new Error("ip and port are required");

  vendorId = vendorId || config.vendorId;

  const { connection_type, printer_type } = classifyDevice(
    { ports: deviceHints.ports || [parseInt(port, 10)], source: deviceHints.source || "lan" },
    deviceHints.printerTypeOverride || null
  );

  return _store(`${vendorId}-${role}`, {
    role,
    printerType:    ROLES[role],
    printer_type,
    connection_type,
    connection:     connection_type,
    label:          label || `${role} printer`,
    ip,
    port:           parseInt(port, 10),
    os_name:        null,
    usb_path:       null,
  });
}

function assignUsb(role, device, label, vendorId) {
  if (!ROLES[role]) throw new Error(`Invalid role "${role}". Must be: ${Object.keys(ROLES).join(", ")}`);

  vendorId = vendorId || config.vendorId;

  return _store(`${vendorId}-${role}`, {
    role,
    printerType:    ROLES[role],
    printer_type:   "pos",
    connection_type: "usb_raw",
    connection:     "usb",
    label:          label || `${role} USB printer`,
    ip:             null,
    port:           null,
    os_name:        null,
    usb_path:       device,
    device,
  });
}

function assignCups(role, cupsName, label, vendorId, ip, printerTypeOverride) {
  if (!ROLES[role]) throw new Error(`Invalid role "${role}". Must be: ${Object.keys(ROLES).join(", ")}`);
  if (!cupsName) throw new Error("cupsName is required");

  vendorId = vendorId || config.vendorId;
  const printer_type = printerTypeOverride || (_looksLikeThermal(cupsName) ? "pos" : "a4");
  const connection   = printer_type === "pos" ? "usb" : "cups";

  return _store(`${vendorId}-${role}`, {
    role,
    printerType:    ROLES[role],
    printer_type,
    connection_type: printer_type === "pos" ? "driver" : "ipp",
    connection,
    label:          label || cupsName,
    ip:             ip || null,
    port:           printer_type === "pos" ? null : 631,
    os_name:        cupsName,
    usb_path:       null,
    cupsName,
  });
}

function assignWindowsSpooler(role, windowsPrinterName, label, vendorId, ip, printerTypeOverride) {
  if (!ROLES[role]) throw new Error(`Invalid role "${role}". Must be: ${Object.keys(ROLES).join(", ")}`);
  if (!windowsPrinterName) throw new Error("windowsPrinterName is required");

  vendorId = vendorId || config.vendorId;
  const printer_type = printerTypeOverride || (_looksLikeThermal(windowsPrinterName) ? "pos" : "a4");

  return _store(`${vendorId}-${role}`, {
    role,
    printerType:    ROLES[role],
    printer_type,
    connection_type: "driver",
    connection:     "winspooler",
    label:          label || windowsPrinterName,
    ip:             ip || null,
    port:           null,
    os_name:        windowsPrinterName,
    usb_path:       null,
    windowsPrinterName,
  });
}

function lookup(printerId) {
  return store.get(String(printerId)) || null;
}

function list() {
  return [...store.values()];
}

function remove(printerId) {
  const existed = store.delete(printerId);
  if (existed) {
    saveToDisk();
    logger.info("Registry: printer removed", { printerId });
  }
  return existed;
}

function getSuggestedIds(vendorId) {
  vendorId = vendorId || config.vendorId;
  return {
    main_thermal:    `${vendorId}-main`,
    kitchen_thermal: `${vendorId}-kitchen`,
    standard_a4:     `${vendorId}-standard`,
  };
}

loadFromDisk();

module.exports = {
  assign,
  assignUsb,
  assignCups,
  assignWindowsSpooler,
  lookup,
  list,
  remove,
  getSuggestedIds,
  classifyDevice,
  looksLikeThermal: _looksLikeThermal,
  ROLES,
};