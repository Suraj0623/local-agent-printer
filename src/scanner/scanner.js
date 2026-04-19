"use strict";

/**
 * scanner.js — Phase 3 (multi-source discovery)
 *
 * Discovery methods:
 *   1. Multi-port LAN scan  — TCP probe across subnet on ports 9100/515/631/80/443 + extras
 *   2. OS Printer detection — PowerShell (Windows) / lpstat (Linux/Mac)
 *   3. USB Device detection — PowerShell USB ports (Windows) / /dev/usb/lpX (Linux)
 *   4. Manual probe        — probeSpecific(ip, port)
 *
 * All methods return the same unified shape:
 *   { ip, ports, source, osPrinterName, usbPath, responseMs }
 */

const net    = require("net");
const os     = require("os");
const { execFile, exec } = require("child_process");
const fs     = require("fs");
const logger = require("../utils/logger");
const config = require("../utils/config");

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PORTS = [9100, 9101, 9102, 515, 631, 80, 443];
const IS_WINDOWS = process.platform === "win32";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Get all local IPv4 LAN interfaces.
 * Returns: [{ address, subnet, iface }]
 */
function getLocalNetworks() {
  const networks = [];
  const ifaces   = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (
        addr.family === "IPv4" &&
        !addr.internal &&
        !addr.address.startsWith("169.254") &&
        addr.address !== "0.0.0.0"
      ) {
        const parts  = addr.address.split(".");
        const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
        networks.push({ address: addr.address, subnet, iface: name });
      }
    }
  }

  return networks;
}

/**
 * Attempt a TCP connection to ip:port.
 * Resolves with { ip, port, responseMs } or rejects.
 */
function probeHost(ip, port, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const start  = Date.now();
    const socket = new net.Socket();
    let settled  = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err
        ? reject(err)
        : resolve({ ip, port, responseMs: Date.now() - start });
    };

    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);

    socket.connect(port, ip, () => {
      clearTimeout(timer);
      finish(null);
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      finish(err);
    });
  });
}

// ── Method 1: Multi-port LAN scan ─────────────────────────────────────────────

/**
 * Scan a /24 subnet across multiple ports.
 * Returns unified discovery objects.
 *
 * @param {string}   subnet      e.g. "192.168.1"
 * @param {number[]} ports       defaults to DEFAULT_PORTS
 * @param {number}   timeout     ms per probe
 * @returns {Promise<Array>}
 */
async function scanSubnet(subnet, ports, timeout) {
  ports   = (ports && ports.length) ? ports : DEFAULT_PORTS;
  timeout = timeout || config.scanTimeoutMs || 300;

  logger.info("Scanner: probing subnet", {
    subnet: `${subnet}.0/24`,
    ports,
    timeout,
  });

  // Build every ip×port probe.
  // IMPORTANT: attach .catch() immediately on each promise before pushing it
  // into the array. Without this, Node.js fires PromiseRejectionHandledWarning
  // for every connection-refused/timeout rejection that occurs in the brief gap
  // between promise creation and Promise.allSettled() attaching its handler.
  // We normalise each probe to always resolve: { ip, port, responseMs } | null.
  const probes = [];
  const MAX_CONCURRENT = 50; // Prevent socket exhaustion

  for (let i = 1; i <= 254; i++) {
    for (const port of ports) {
      probes.push(probeHost(`${subnet}.${i}`, port, timeout).catch(() => null));
      // Simple concurrency control: yield if too many pending
      if (probes.length % MAX_CONCURRENT === 0) {
        await new Promise(res => setImmediate(res));
      }
    }
  }

  // All probes now resolve (never reject), so Promise.all is safe and clean.
  const settled = await Promise.all(probes);

  // Group open ports by IP (null entries = failed probes, skip them)
  const byIp = new Map(); // ip → { ports: Set, minMs: number }
  for (const r of settled) {
    if (!r) continue;
    const { ip, port, responseMs } = r;
    if (!byIp.has(ip)) byIp.set(ip, { ports: new Set(), minMs: responseMs });
    byIp.get(ip).ports.add(port);
    byIp.get(ip).minMs = Math.min(byIp.get(ip).minMs, responseMs);
  }

  const found = [];
  for (const [ip, { ports: openPorts, minMs }] of byIp) {
    found.push({
      ip,
      ports:         [...openPorts].sort((a, b) => a - b),
      source:        "lan",
      osPrinterName: null,
      usbPath:       null,
      responseMs:    minMs,
    });
  }

  logger.info("Scanner: LAN scan complete", {
    subnet: `${subnet}.0/24`,
    found:  found.length,
    ips:    found.map(f => f.ip),
  });

  return found;
}

/**
 * Scan all detected local subnets (multi-NIC aware).
 *
 * @param {number[]} extraPorts  additional ports to probe beyond defaults
 * @returns {Promise<Array>}
 */
async function scanAllNetworks(extraPorts) {
  const networks = getLocalNetworks();

  if (!networks.length) {
    logger.warn("Scanner: no local network interfaces found");
    return [];
  }

  logger.info("Scanner: found local networks", {
    networks: networks.map(n => `${n.address} (${n.iface})`),
  });

  const ports      = [...new Set([...DEFAULT_PORTS, ...(extraPorts || [])])];
  const seenSubnets = new Set();
  const allFound   = [];

  for (const net of networks) {
    if (seenSubnets.has(net.subnet)) continue;
    seenSubnets.add(net.subnet);
    const found = await scanSubnet(net.subnet, ports);
    allFound.push(...found);
  }

  // Deduplicate by IP (merge ports if same IP found on multiple interfaces)
  const unique   = new Map();
  for (const p of allFound) {
    if (!unique.has(p.ip)) {
      unique.set(p.ip, { ...p });
    } else {
      // Merge ports from duplicate IPs
      const existing = unique.get(p.ip);
      p.ports.forEach(port => existing.ports.add(port));
      existing.ports = [...new Set([...existing.ports, ...p.ports])].sort((a, b) => a - b);
      existing.minMs = Math.min(existing.minMs, p.minMs);
    }
  }

  return [...unique.values()];
}

// ── Method 2: OS Printer detection ───────────────────────────────────────────

/**
 * Discover printers registered with the OS.
 * Windows → PowerShell Get-Printer
 * Linux/Mac → lpstat
 *
 * @returns {Promise<Array>}
 */
async function discoverOsPrinters() {
  return IS_WINDOWS ? _discoverWindows() : _discoverLpstat();
}

function _discoverWindows() {
  return new Promise((resolve) => {
    const ps = `Get-Printer | Select-Object Name, PortName, DriverName, PrinterType | ConvertTo-Json`;
    execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        logger.warn("Scanner: PowerShell Get-Printer failed", { error: err.message });
        return resolve([]);
      }
      try {
        let raw = JSON.parse(stdout.trim());
        if (!Array.isArray(raw)) raw = [raw];

        const printers = raw.map(p => {
          // PortName can be "IP_192.168.1.50", "USB001", "LPT1", etc.
          const ipMatch = (p.PortName || "").match(/(?:IP_|tcp_)?(\d{1,3}(?:\.\d{1,3}){3})/i);
          const isUsbPort = (p.PortName || "").toUpperCase().startsWith("USB");
          
          return {
            ip:            ipMatch ? ipMatch[1] : null,
            ports:         [],                       // OS-managed; no raw port needed
            source:        "os",
            osPrinterName: p.Name        || null,
            driverName:    p.DriverName  || null,
            portName:      p.PortName    || null,
            usbPath:       isUsbPort ? p.PortName : null,
            printerType:   p.PrinterType || null,
            isUsb:         isUsbPort,
          };
        });

        logger.info("Scanner: Windows OS printers found", { count: printers.length });
        resolve(printers);
      } catch (parseErr) {
        logger.warn("Scanner: failed to parse PowerShell output", { error: parseErr.message });
        resolve([]);
      }
    });
  });
}

function _discoverLpstat() {
  return new Promise((resolve) => {
    exec("lpstat -v 2>/dev/null", { timeout: 8000 }, (err, stdout) => {
      if (err && !stdout) {
        logger.warn("Scanner: lpstat failed", { error: err.message });
        return resolve([]);
      }

      const printers = [];
      for (const line of stdout.trim().split("\n")) {
        const m = line.match(/device for (.+?):\s+(.+)/);
        if (!m) continue;

        const name   = m[1].trim();
        const device = m[2].trim();

        // Extract IP if present
        const ipMatch = device.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
        // Detect USB device
        const isUsb   = device.startsWith("/dev/");

        printers.push({
          ip:            ipMatch ? ipMatch[1] : null,
          ports:         [],
          source:        "os",
          osPrinterName: name,
          usbPath:       isUsb ? device : null,
          deviceUri:     device,
          isUsb,
        });
      }

      logger.info("Scanner: Linux/Mac OS printers found", { count: printers.length });
      resolve(printers);
    });
  });
}

// ── Method 3: USB Device detection (Cross-platform) ───────────────────────────

/**
 * Enumerate USB printers.
 * Windows → PowerShell: join USB ports with Get-Printer to get real printer names
 * Linux → /dev/usb/lpX device files
 *
 * @returns {Promise<Array>}
 */
async function discoverUsbDevices() {
  return IS_WINDOWS ? _discoverWindowsUsb() : _discoverLinuxUsb();
}

/**
 * Windows: Detect USB printer ports and cross-reference with installed printers
 * so that osPrinterName is populated — enabling accurate thermal vs A4 detection.
 *
 * Key fix: previously osPrinterName was always null for USB entries, causing every
 * USB device to be classified as POS. Now we join Get-PrinterPort with Get-Printer
 * so e.g. USB001 → "Canon LBP2900" → classified as A4.
 */
function _discoverWindowsUsb() {
  return new Promise((resolve) => {
    // Join USB printer ports with the printers attached to them.
    // This gives us the real printer name for accurate type classification.
    const ps = `
$ports = Get-PrinterPort | Where-Object { $_.Name -like 'USB*' };
$printers = Get-Printer | Select-Object Name, PortName, DriverName;
$result = $ports | ForEach-Object {
  $port = $_;
  $printer = $printers | Where-Object { $_.PortName -eq $port.Name } | Select-Object -First 1;
  [PSCustomObject]@{
    PortName    = $port.Name;
    PrinterName = if ($printer) { $printer.Name } else { $null };
    DriverName  = if ($printer) { $printer.DriverName } else { $null };
  }
};
$result | ConvertTo-Json
`.trim();

    execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        logger.warn("Scanner: PowerShell USB port query failed", { error: err.message });
        return resolve([]);
      }

      try {
        const text = (stdout || "").trim();
        if (!text) return resolve([]);

        let raw = JSON.parse(text);
        if (!Array.isArray(raw)) raw = [raw];

        const printers = raw
          .filter(p => p.PortName)
          .map(p => ({
            ip:            null,
            ports:         [],
            source:        "usb",
            // ← This is the critical fix: populate osPrinterName from Get-Printer join
            // so classifyDevice() / _looksLikeThermal() can correctly type the device
            osPrinterName: p.PrinterName || null,
            driverName:    p.DriverName  || null,
            usbPath:       p.PortName,   // e.g. "USB001"
            portName:      p.PortName,
            windowsPort:   9101,
            note:          "Use OS Printers tab for spooler-based printing, or assign as USB for raw ESC/POS",
          }));

        logger.info("Scanner: Windows USB printer ports found", {
          count:    printers.length,
          printers: printers.map(p => `${p.usbPath} → ${p.osPrinterName || "unknown"}`),
        });
        resolve(printers);
      } catch (parseErr) {
        logger.warn("Scanner: failed to parse PowerShell USB output", { error: parseErr.message });
        resolve([]);
      }
    });
  });
}

/**
 * Linux: Enumerate /dev/usb/lpX device files
 * Optionally enrich with lsusb vendor info
 */
async function _discoverLinuxUsb() {
  const usbDir = "/dev/usb";
  const found  = [];

  try {
    if (!fs.existsSync(usbDir)) {
      logger.debug("Scanner: /dev/usb directory not found (may need 'usb-printer' kernel module)");
      return [];
    }
    
    const entries = fs.readdirSync(usbDir);

    for (const entry of entries) {
      if (!entry.startsWith("lp")) continue;
      const usbPath = `${usbDir}/${entry}`;

      // Verify it's a character device we can potentially write to
      try {
        const stat = fs.statSync(usbPath);
        if (!stat.isCharacterDevice()) continue;
      } catch {
        continue; // Skip if we can't stat the file
      }

      found.push({
        ip:            null,
        ports:         [],
        source:        "usb",
        osPrinterName: null,
        usbPath,
        permissions:   "unknown",
      });
    }
  } catch (err) {
    logger.warn("Scanner: USB enumeration failed", { error: err.message });
    return [];
  }

  // Try to enrich with lsusb for vendor/product info
  if (found.length > 0) {
    try {
      const lsusbOutput = await new Promise((res) => {
        exec("lsusb 2>/dev/null", { timeout: 5000 }, (err, stdout) => res(stdout || ""));
      });
      
      if (lsusbOutput?.trim()) {
        for (const d of found) {
          d.lsusbHint = lsusbOutput.trim();
        }
      }
    } catch (lsusbErr) {
      logger.debug("Scanner: lsusb enrichment skipped", { error: lsusbErr.message });
    }
  }

  logger.info("Scanner: Linux USB devices found", {
    count:   found.length,
    devices: found.map(d => d.usbPath),
  });

  return found;
}

// ── Method 4: Manual probe ────────────────────────────────────────────────────

/**
 * Test connectivity to a specific ip:port.
 * Used by /api/probe UI endpoint.
 *
 * @param {string} ip
 * @param {number} port
 * @returns {Promise<{ reachable: boolean, responseMs: number|null, error: string|null }>}
 */
async function probeSpecific(ip, port) {
  try {
    const result = await probeHost(ip, parseInt(port, 10), config.scanTimeoutMs || 1500);
    return { reachable: true, ip, port, responseMs: result.responseMs, error: null };
  } catch (err) {
    return { reachable: false, ip, port, responseMs: null, error: err.message };
  }
}

// ── ESC/POS test page ─────────────────────────────────────────────────────────

/**
 * Send a minimal ESC/POS test page to an IP:port thermal printer.
 */
function sendTestPrint(ip, port, label) {
  return new Promise((resolve, reject) => {
    const socket  = new net.Socket();
    let settled   = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    const ESC = 0x1B;
    const GS  = 0x1D;

    const text = [
      `--------------------------------`,
      `  PRINT AGENT TEST PAGE`,
      `  ${label || "Test"}`,
      `  IP: ${ip}:${port}`,
      `  ${new Date().toLocaleString()}`,
      `--------------------------------`,
      ``, ``, ``,
    ].join("\n");

    const initCmd = Buffer.from([ESC, 0x40]);
    const textBuf = Buffer.from(text, "utf8");
    const cutCmd  = Buffer.from([GS, 0x56, 0x41, 0x03]);
    const payload = Buffer.concat([initCmd, textBuf, cutCmd]);

    const timer = setTimeout(
      () => finish(new Error(`Connection timeout to ${ip}:${port}`)),
      config.printerConnectTimeoutMs || 5000
    );

    socket.connect(port, ip, () => {
      clearTimeout(timer);
      socket.write(payload, (err) => {
        if (err) return finish(err);
        setTimeout(() => socket.end(() => finish(null)), 300);
      });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      finish(new Error(`${ip}:${port} — ${err.message}`));
    });
  });
}

module.exports = {
  scanAllNetworks,
  scanSubnet,
  discoverOsPrinters,
  discoverUsbDevices,
  probeSpecific,
  sendTestPrint,
  getLocalNetworks,
  DEFAULT_PORTS,
};