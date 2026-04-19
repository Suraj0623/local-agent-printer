"use strict";

/**
 * pdfAdapter.js — Handles `pdf_uri` content type.
 *
 * Laravel sends a URL to a pre-rendered PDF invoice.
 * This adapter:
 *  1. Fetches the PDF from the URL
 *  2. Converts it to a printable format
 *
 * Strategy A (default): Forward the raw PDF bytes to the printer.
 *   Works if your printer supports PDF rendering (most modern network printers do).
 *
 * Strategy B: Rasterize via Ghostscript → ESC/POS raster.
 *   Uncomment the gs block below for full thermal PDF printing.
 *   Requires: apt-get install ghostscript
 *
 * For restaurant use, Strategy A (forwarding to a PDF-capable laser/inkjet)
 * is almost always correct for the A4 standard invoice.
 */

const fetch  = require("node-fetch");
const net    = require("net");
const logger = require("../utils/logger");

const PDF_FETCH_TIMEOUT = parseInt(process.env.PDF_FETCH_TIMEOUT || "15000");
const CONNECT_TIMEOUT   = parseInt(process.env.PRINTER_CONNECT_TIMEOUT || "5000");
const WRITE_TIMEOUT     = parseInt(process.env.PRINTER_WRITE_TIMEOUT   || "8000");

/**
 * Fetch PDF from URL and send raw bytes to a network printer.
 * (Standard network printers accept PDF over port 9100 directly)
 *
 * @param {object} printerConfig
 * @param {string} pdfUrl
 * @param {object} [ctx] – log context
 */
async function printPdfUri(printerConfig, pdfUrl, ctx = {}) {
  const { ip, port = 9100, id, label } = printerConfig;

  logger.info("Fetching PDF for print", { ...ctx, printerId: id, pdfUrl });

  // ── Fetch PDF ─────────────────────────────────────────────────────────────
  let pdfBuffer;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT);

    const res = await fetch(pdfUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching PDF from ${pdfUrl}`);
    }
    pdfBuffer = await res.buffer();
  } catch (err) {
    throw new Error(`Failed to fetch PDF: ${err.message}`);
  }

  logger.info("PDF fetched", {
    ...ctx,
    printerId: id,
    bytes: pdfBuffer.length,
  });

  // ── Send to printer ───────────────────────────────────────────────────────
  return sendBufferToNetwork({ ip, port, id, label }, pdfBuffer, ctx);
}

/**
 * Internal: open TCP socket and stream buffer to printer.
 */
function sendBufferToNetwork({ ip, port, id, label }, buffer, ctx) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    }

    const connectTimer = setTimeout(() => {
      finish(new Error(`Printer ${id}: connect timeout (${CONNECT_TIMEOUT}ms)`));
    }, CONNECT_TIMEOUT);

    socket.connect({ host: ip, port: Number(port) }, () => {
      clearTimeout(connectTimer);

      logger.info("PDF printer connected", {
        ...ctx, printerId: id, label, ip, port,
      });

      const writeTimer = setTimeout(() => {
        finish(new Error(`Printer ${id}: write timeout (${WRITE_TIMEOUT}ms)`));
      }, WRITE_TIMEOUT);

      socket.write(buffer, (err) => {
        clearTimeout(writeTimer);
        if (err) return finish(new Error(`Printer ${id}: write error — ${err.message}`));
        socket.end(() => finish(null));
      });
    });

    socket.on("error", (err) => {
      clearTimeout(connectTimer);
      finish(new Error(`Printer ${id} (${ip}:${port}): ${err.message}`));
    });
  });
}

module.exports = { printPdfUri };