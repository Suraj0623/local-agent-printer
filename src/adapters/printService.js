"use strict";

const logger = require("../utils/logger");
const { printNetwork } = require("./networkAdapter");

/**
 * printService.js — Production Ready Unified Printer Service
 * 
 * Supports:
 * 1. Network Printers (Raw TCP/IP for Thermal, PDF for Laser)
 * 2. USB Thermal Printers (Direct ESC/POS via libusb - Requires WinUSB on Windows)
 * 3. Windows Spooler PDF Printers (SumatraPDF fallback -> .NET API)
 * 4. CUPS/Linux USB (Device file writing)
 */

async function executePrintJob(job, printerConfig) {
  const ctx = {
    jobId:     job.id,
    orderId:   job.order_id,
    printerId: job.printer_node_id,
  };

  // Normalize connection types from registry
  const connection  = printerConfig.connection_type || printerConfig.connection || "network";
  const printerType = printerConfig.printer_type || _guessType(connection);
  const contentType = job.content_type;

  logger.info("Executing print job", {
    ...ctx, 
    contentType, 
    printerType, 
    connection,
    ip: printerConfig.ip, 
    port: printerConfig.port,
  });

  // ── Validation ──────────────────────────────────────────────────────────────
  
  // Hard block: Sending raw ESC/POS commands to an A4 Laser printer usually results in garbage
  if (printerType === "a4" && contentType === "raw_base64") {
    throw new Error(
      `Job ${job.id}: Cannot send ESC/POS (raw_base64) to A4 printer "${printerConfig.id}". ` +
      `A4 printers require pdf_base64.`
    );
  }

  if (!["raw_base64", "pdf_base64"].includes(contentType)) {
    throw new Error(`Job ${job.id}: Unsupported content_type "${contentType}". Expected raw_base64 or pdf_base64.`);
  }

  // Decode Base64 content to Buffer
  const dataBuffer = _resolveBuffer(job, ctx);

  // ── Routing Logic ───────────────────────────────────────────────────────────

  try {
    if (["raw", "network", "lan"].includes(connection)) {
      // Network: Send raw bytes (Thermal) or PDF bytes (Laser with PDF firmware)
      await printNetwork(printerConfig, dataBuffer, ctx);

    } else if (["usb", "usb_raw"].includes(connection)) {
      // USB: Direct device write (Linux/Mac) or Raw USB (Windows via escpos)
      await _printUsbUniversal(printerConfig, dataBuffer, ctx, printerType);

    } else if (["cups", "ipp"].includes(connection)) {
      // Linux/Mac CUPS
      await _printCups(printerConfig, dataBuffer, ctx);

    } else if (["winspooler", "driver"].includes(connection)) {
      // Windows: 
      // - If Thermal (pos) + Raw: Use Direct USB (bypasses spooler issues)
      // - If A4 (a4) + PDF: Use SumatraPDF/.NET Spooler
      await _printWindowsUniversal(printerConfig, dataBuffer, ctx, printerType, contentType);

    } else {
      throw new Error(`Job ${job.id}: Unknown connection type "${connection}".`);
    }

    logger.info("Print job executed successfully", {
      ...ctx, 
      bytes: dataBuffer.length,
    });

  } catch (err) {
    logger.error("Print job failed", { ...ctx, error: err.message });
    throw err; // Re-throw to trigger retry logic in poller
  }
}

// ── Universal Windows Handler ─────────────────────────────────────────────────

async function _printWindowsUniversal(printerConfig, dataBuffer, ctx, printerType, contentType) {
  const printerName = printerConfig.windowsPrinterName
    || printerConfig.os_name
    || printerConfig.label;

  // CASE 1: Thermal Printer (POS) receiving Raw ESC/POS
  // We bypass the Windows Spooler entirely because it expects documents (PDF/XPS), not raw binary streams.
  // We use 'escpos' + 'usb' to talk directly to the USB device.
  if (printerType === "pos" && contentType === "raw_base64") {
    logger.info("Windows: Routing Thermal/Raw job to Direct USB driver", { ...ctx, printerName });
    return _printUsbRawDirect(dataBuffer, ctx);
  }

  // CASE 2: A4/Laser Printer receiving PDF
  // Use the robust PDF printing pipeline (SumatraPDF -> .NET API)
  logger.info("Windows: Routing A4/PDF job to Spooler", { ...ctx, printerName });
  return _printWindowsPdfSpooler(printerConfig, dataBuffer, ctx);
}

// ── Universal USB Handler ─────────────────────────────────────────────────────

async function _printUsbUniversal(printerConfig, dataBuffer, ctx, printerType) {
  // On Windows, even if configured as "USB", we prefer the escpos library for reliability.
  // On Linux/Mac, we fall back to device file writing if escpos isn't available or preferred.
  
  if (process.platform === "win32") {
    // Windows: Always try direct USB via escpos first for better compatibility
    return _printUsbRawDirect(dataBuffer, ctx);
  } else {
    // Linux/Mac: Try device file write first (standard /dev/usb/lp0)
    try {
      await _printUsbDeviceFile(printerConfig, dataBuffer, ctx);
    } catch (err) {
      logger.warn("USB Device file write failed, trying escpos fallback", { error: err.message });
      // Fallback to escpos if device file fails (permissions issues etc)
      return _printUsbRawDirect(dataBuffer, ctx);
    }
  }
}

// ── Implementation: Direct USB Raw Printing (Windows/Mac/Linux) ───────────────
// Requires: npm install usb escpos escpos-usb
async function _printUsbRawDirect(dataBuffer, ctx) {
  const escpos = require("escpos");
  escpos.USB = require("escpos-usb");

  logger.info("USB: Direct ESC/POS via escpos-usb", {
    ...ctx,
    bytes: dataBuffer.length
  });

  return new Promise((resolve, reject) => {
    let device;

    try {
      // LOCKED to your printer
      device = new escpos.USB(0x0483, 0x5743);
    } catch (err) {
      return reject(new Error(`USB device init failed: ${err.message}`));
    }

    const printer = new escpos.Printer(device, {
      encoding: "UTF-8"
    });

    device.open((err) => {
      if (err) {
        return reject(new Error(`USB open failed: ${err.message}`));
      }

      try {
        printer.raw(dataBuffer);

        // Optional safety commands
        printer.encode("UTF-8");
        printer.align("LT");

        printer.cut();
        printer.close();

        logger.info("USB: Print success", ctx);
        resolve();

      } catch (printErr) {
        reject(new Error(`USB print failed: ${printErr.message}`));
      }
    });
  });
}

// ── Implementation: Windows PDF Spooler (SumatraPDF -> .NET) ──────────────────

async function _printWindowsPdfSpooler(printerConfig, dataBuffer, ctx) {
  const fs   = require("fs");
  const os   = require("os");
  const path = require("path");

  const printerName = printerConfig.windowsPrinterName
    || printerConfig.os_name
    || printerConfig.label;

  const tmpFile = path.join(os.tmpdir(), `pj_${ctx.jobId || Date.now()}.pdf`);

  logger.info("Windows PDF: Writing temp file", { ...ctx, tmpFile });
  fs.writeFileSync(tmpFile, dataBuffer);

  let lastError;

  // Strategy 1: SumatraPDF (Fastest, Silent, No UI)
  const sumatraPath = _findSumatraPDF();
  if (sumatraPath) {
    try {
      await _printWithSumatra(sumatraPath, printerName, tmpFile, ctx);
      _cleanupFile(tmpFile, 3000);
      return;
    } catch (e) {
      lastError = e;
      logger.warn("Windows PDF: SumatraPDF failed, falling back to .NET", { ...ctx, error: e.message });
    }
  }

  // Strategy 2: .NET System.Printing API (Built-in, No external tools)
  try {
    await _printWithDotNet(printerName, tmpFile, dataBuffer, ctx);
    _cleanupFile(tmpFile, 3000);
    return;
  } catch (e) {
    lastError = e;
    logger.warn("Windows PDF: .NET API failed, falling back to Network", { ...ctx, error: e.message });
  }

  // Strategy 3: Network Fallback (If IP is known)
  if (printerConfig.ip && printerConfig.port) {
    logger.info("Windows PDF: Trying direct TCP fallback", { ...ctx, ip: printerConfig.ip });
    try {
      // Note: Most laser printers don't accept raw PDF over port 9100 unless they have specific firmware.
      // This is a last resort.
      await printNetwork(printerConfig, dataBuffer, ctx);
      _cleanupFile(tmpFile);
      return;
    } catch (e) {
      lastError = e;
      logger.warn("Windows PDF: TCP fallback failed", { ...ctx, error: e.message });
    }
  }

  _cleanupFile(tmpFile);

  throw new Error(
    `Windows PDF printing failed after all strategies. Last error: ${lastError?.message}. ` +
    `Recommendation: Install SumatraPDF and place SumatraPDF.exe in the project root or set SUMATRA_PATH env var.`
  );
}

// ── Helper: Find SumatraPDF ───────────────────────────────────────────────────

function _findSumatraPDF() {
  const fs   = require("fs");
  const path = require("path");

  const candidates = [
    process.env.SUMATRA_PATH,
    path.join(process.cwd(), "tools", "SumatraPDF.exe"),
    path.join(__dirname, "..", "..", "tools", "SumatraPDF.exe"),
    "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
    "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe",
  ].filter(Boolean);

  return candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || null;
}

async function _printWithSumatra(sumatraPath, printerName, tmpFile, ctx) {
  const { execFile } = require("child_process");

  const args = printerName
    ? ["-print-to", printerName, "-print-settings", "fit,color", tmpFile]
    : ["-print-to-default", "-print-settings", "fit,color", tmpFile];

  logger.info("SumatraPDF: Executing print", { ...ctx, printerName });

  await new Promise((resolve, reject) => {
    execFile(sumatraPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`SumatraPDF Error: ${stderr || err.message}`));
      logger.info("SumatraPDF: Job submitted", { ...ctx });
      resolve();
    });
  });
}

async function _printWithDotNet(printerName, tmpFile, dataBuffer, ctx) {
  const { execFile } = require("child_process");

  const escaped = tmpFile.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const printerEsc = (printerName || "").replace(/'/g, "\\'");

  // PowerShell script using System.Printing to send raw bytes to spooler
  const ps = `
Add-Type -AssemblyName System.Printing;
Add-Type -AssemblyName ReachFramework;
$printerName = '${printerEsc}';
$bytes = [System.IO.File]::ReadAllBytes('${escaped}');
$server = New-Object System.Printing.LocalPrintServer;
$queue = if ($printerName) { $server.GetPrintQueue($printerName) } else { $server.DefaultPrintQueue };
$job = $queue.AddJob('Agent-${ctx.jobId}');
$stream = $job.JobStream;
$stream.Write($bytes, 0, $bytes.Length);
$stream.Close();
Write-Host "OK";
`.trim();

  await new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`.NET Print Error: ${stderr || err.message}`));
      logger.info(".NET API: Job submitted", { ...ctx });
      resolve();
    });
  });
}

// ── Helper: Linux/Mac USB Device File ─────────────────────────────────────────

async function _printUsbDeviceFile(printerConfig, dataBuffer, ctx) {
  const fs      = require("fs");
  const config  = require("../utils/config");
  const device  = printerConfig.device || printerConfig.usb_path || "/dev/usb/lp0";
  const timeout = config.printerWriteTimeoutMs || 8000;

  await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer  = setTimeout(() => {
      timedOut = true;
      reject(new Error(`USB Timeout: ${device}`));
    }, timeout);

    fs.open(device, "w", (openErr, fd) => {
      if (openErr) { clearTimeout(timer); return reject(new Error(`Cannot open ${device}: ${openErr.message}`)); }
      
      fs.write(fd, dataBuffer, 0, dataBuffer.length, (writeErr, bytes) => {
        fs.close(fd, () => {});
        clearTimeout(timer);
        if (timedOut) return;
        if (writeErr) return reject(new Error(`USB Write Error: ${writeErr.message}`));
        
        logger.info("USB Device: Write complete", { ...ctx, device, bytes });
        resolve();
      });
    });
  });
}

// ── Helper: CUPS (Linux/Mac) ──────────────────────────────────────────────────

async function _printCups(printerConfig, dataBuffer, ctx) {
  const { execFile } = require("child_process");
  const fs           = require("fs");
  const os           = require("os");
  const path         = require("path");

  const printerName = printerConfig.cupsName || printerConfig.os_name || printerConfig.label || "default";
  const tmpFile     = path.join(os.tmpdir(), `pj_${ctx.jobId || Date.now()}.pdf`);

  try {
    fs.writeFileSync(tmpFile, dataBuffer);
    await new Promise((resolve, reject) => {
      execFile("lp", ["-d", printerName, tmpFile], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`CUPS lp Error: ${stderr || err.message}`));
        logger.info("CUPS: Job submitted", { ...ctx, printerName });
        resolve();
      });
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _guessType(connection) {
  // Heuristic: USB and Raw Network are usually Thermal (POS). Everything else is likely A4.
  if (["usb", "usb_raw", "raw", "network", "lan"].includes(connection)) return "pos";
  return "a4";
}

function _resolveBuffer(job, ctx) {
  const buf = Buffer.from(job.content, "base64");
  
  if (job.content_type === "pdf_base64") {
    // Basic validation: PDFs must start with %PDF
    if (buf.slice(0, 4).toString() !== "%PDF") {
      logger.warn("PDF Validation Warning: Content does not start with %PDF header", { ...ctx });
      // We don't throw here to allow some flexibility, but it might fail later
    }
    logger.debug("Content: pdf_base64", { ...ctx, bytes: buf.length });
  } else {
    logger.debug("Content: raw_base64 (ESC/POS)", { ...ctx, bytes: buf.length });
  }
  return buf;
}

function _cleanupFile(filePath, delayMs = 0) {
  const cleanup = () => { 
    try { 
      require("fs").unlinkSync(filePath); 
    } catch (_) {} 
  };
  delayMs > 0 ? setTimeout(cleanup, delayMs) : cleanup();
}

module.exports = { executePrintJob };