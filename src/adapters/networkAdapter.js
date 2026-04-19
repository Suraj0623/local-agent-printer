"use strict";

const net    = require("net");
const logger = require("../utils/logger");
const config = require("../utils/config");

/**
 * Send raw ESC/POS bytes to a network printer via TCP socket.
 * Port 9100 is the standard raw print port for Epson/Star/etc.
 */
function printNetwork(printerConfig, dataBuffer, ctx = {}) {
  const { ip, port = 9100, id, label } = printerConfig;
  const connectTimeout = config.printerConnectTimeoutMs || 5000;
  const writeTimeout   = config.printerWriteTimeoutMs   || 8000;

  return new Promise((resolve, reject) => {
    const socket  = new net.Socket();
    let settled   = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    const connectTimer = setTimeout(
      () => finish(new Error(`Printer ${id} (${ip}:${port}): connection timeout after ${connectTimeout}ms`)),
      connectTimeout
    );

    socket.connect({ host: ip, port: Number(port) }, () => {
      clearTimeout(connectTimer);
      logger.info("Printer connected", { ...ctx, printerId: id, ip, port });

      const writeTimer = setTimeout(
        () => finish(new Error(`Printer ${id}: write timeout after ${writeTimeout}ms`)),
        writeTimeout
      );

      socket.write(dataBuffer, (err) => {
        clearTimeout(writeTimer);
        if (err) return finish(new Error(`Printer ${id}: write error — ${err.message}`));
        // Small delay to let printer buffer the data before we close
        setTimeout(() => socket.end(() => finish(null)), 250);
      });
    });

    socket.on("error", (err) => {
      clearTimeout(connectTimer);
      finish(new Error(`Printer ${id} (${ip}:${port}): ${err.message}`));
    });
  });
}

module.exports = { printNetwork };
