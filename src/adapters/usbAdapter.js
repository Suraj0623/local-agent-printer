"use strict";

/**
 * usbAdapter.js — local agent USB printing with safe fallbacks.
 *
 * Supported strategies:
 *  - Windows recommended: use a shared USB printer exposed as a TCP port on loopback
 *      printerConfig: { connection:"usb", windowsPort: 9101 }
 *    This avoids flaky direct-USB Node bindings on Windows.
 *
 *  - Linux/Mac: write directly to a device file (e.g. /dev/usb/lp0)
 *      printerConfig: { connection:"usb", device:"/dev/usb/lp0" }
 *
 *  - Optional: escpos/escpos-usb direct USB (best-effort fallback if installed)
 */

const fs = require("fs");
const logger = require("../utils/logger");
const config = require("../utils/config");
const { printNetwork } = require("./networkAdapter");

const isWindows = process.platform === "win32";

async function printUsb(printerConfig, dataBuffer, ctx = {}) {
  if (!Buffer.isBuffer(dataBuffer)) {
    throw new Error("USB print: dataBuffer must be a Buffer");
  }

  // ── Windows: prefer loopback TCP port ───────────────────────────────────────
  if (isWindows && printerConfig.windowsPort) {
    const port = Number(printerConfig.windowsPort);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`USB print: invalid windowsPort "${printerConfig.windowsPort}"`);
    }

    logger.info("USB print: using Windows loopback port", { ...ctx, port });
    return printNetwork(
      { ...printerConfig, connection: "network", ip: "127.0.0.1", port, id: printerConfig.id || "usb" },
      dataBuffer,
      ctx
    );
  }

  // ── POSIX: write to device file if provided (or default) ────────────────────
  const device = printerConfig.device || (!isWindows ? "/dev/usb/lp0" : null);
  if (device && typeof device === "string" && device.startsWith("/")) {
    logger.info("USB print: writing to device file", { ...ctx, device });

    const writeTimeout = config.printerWriteTimeoutMs || 8000;

    await new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`USB write timeout after ${writeTimeout}ms (${device})`));
      }, writeTimeout);

      fs.open(device, "w", (openErr, fd) => {
        if (openErr) {
          clearTimeout(timer);
          return reject(new Error(`Cannot open USB device ${device}: ${openErr.message}`));
        }

        fs.write(fd, dataBuffer, 0, dataBuffer.length, (writeErr, bytes) => {
          fs.close(fd, () => {});
          clearTimeout(timer);
          if (timedOut) return;
          if (writeErr) return reject(new Error(`USB write failed: ${writeErr.message}`));
          logger.info("USB print: write complete", { ...ctx, device, bytes });
          resolve();
        });
      });
    });

    return;
  }

  // ── Optional fallback: escpos-usb (if installed) ────────────────────────────
  let escpos, EscposUSB;
  try {
    escpos = require("escpos");
    EscposUSB = require("escpos-usb");
  } catch {
    throw new Error(
      "USB printing is not configured. " +
      (isWindows
        ? "On Windows set printerConfig.windowsPort (recommended). "
        : "On Linux/Mac set printerConfig.device (e.g. /dev/usb/lp0). ") +
      "Optional: install escpos + escpos-usb for direct USB printing."
    );
  }

  const openTimeout = config.printerConnectTimeoutMs || 5000;

  await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error(`USB open timeout after ${openTimeout}ms`));
    }, openTimeout);

    let usbDevice;
    try {
      usbDevice = printerConfig.device
        ? new EscposUSB(printerConfig.device)
        : EscposUSB.getDevice();
    } catch (err) {
      clearTimeout(timer);
      return finish(new Error(`USB device not found (${printerConfig.device || "auto"}): ${err.message}`));
    }

    usbDevice.open((err) => {
      clearTimeout(timer);
      if (err) return finish(new Error(`Failed to open USB device: ${err.message}`));

      logger.info("USB device opened (escpos-usb)", { ...ctx, device: printerConfig.device });

      const printer = new escpos.Printer(usbDevice);
      try {
        printer.raw(dataBuffer);
        printer.cut().close((closeErr) => {
          if (closeErr) return finish(new Error(`Error closing USB device: ${closeErr.message}`));
          finish(null);
        });
      } catch (printErr) {
        finish(new Error(`USB print error: ${printErr.message}`));
      }
    });
  });
}

module.exports = { printUsb };

