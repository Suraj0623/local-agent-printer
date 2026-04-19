"use strict";

const { createLogger, format, transports } = require("winston");
require("winston-daily-rotate-file");
const path = require("path");
const fs   = require("fs");

const logDir = process.env.LOG_DIR || "./logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const jsonFmt = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  format.errors({ stack: true }),
  format.printf(({ level, message, timestamp, ...meta }) =>
    JSON.stringify({ ts: timestamp, level: level.toUpperCase(), message, ...meta })
  )
);

const consoleFmt = format.combine(
  format.colorize(),
  format.timestamp({ format: "HH:mm:ss" }),
  format.printf(({ level, message, timestamp, ...meta }) => {
    const ctx = Object.keys(meta).length
      ? "  " + JSON.stringify(meta)
      : "";
    return `${timestamp} ${level}: ${message}${ctx}`;
  })
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  transports: [
    new transports.Console({ format: consoleFmt }),
    new transports.DailyRotateFile({
      format: jsonFmt,
      dirname: logDir,
      filename: "agent-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
      zippedArchive: true,
    }),
    new transports.DailyRotateFile({
      level: "error",
      format: jsonFmt,
      dirname: logDir,
      filename: "agent-error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
      zippedArchive: true,
    }),
  ],
});

module.exports = logger;
