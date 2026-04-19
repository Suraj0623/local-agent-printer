#!/usr/bin/env node
"use strict";

/**
 * testPoll.js — end-to-end connectivity test
 *
 * Tests the full chain:
 *   1. Verify agent can reach Laravel  (GET /api/agent/status)
 *   2. Poll for pending jobs           (GET /api/agent/jobs)
 *   3. Check registry has assignments  (local printers.json)
 *   4. Send test print to each printer (TCP probe)
 *
 * Run: node scripts/testPoll.js
 */

require("dotenv").config();
const axios    = require("axios");
const config   = require("../src/utils/config");
const registry = require("../src/registry/registry");
const { sendTestPrint } = require("../src/scanner/scanner");

const http = axios.create({
  baseURL: config.laravelUrl,
  timeout: 8000,
  headers: {
    "X-Agent-Key":  config.agentKey,
    "X-Agent-Id":   config.agentId,
  },
});

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`  ℹ  ${msg}`); }

async function run() {
  console.log("=".repeat(50));
  console.log(" Print Agent — End-to-End Test");
  console.log("=".repeat(50));
  console.log(`  Laravel URL : ${config.laravelUrl}`);
  console.log(`  Vendor ID   : ${config.vendorId}`);
  console.log(`  Agent ID    : ${config.agentId}`);
  console.log();

  let passed = 0, failed = 0;

  // ── Test 1: Laravel connectivity ─────────────────────────────────────────
  console.log("1. Laravel connectivity...");
  try {
    const res  = await http.get("/api/agent/status");
    const data = res.data;
    ok(`Connected — vendor: "${data.vendor_name}" (#${data.vendor_id})`);
    info(`Printer IDs in Laravel: ${JSON.stringify(data.printer_ids)}`);
    passed++;
  } catch (err) {
    const status = err.response?.status;
    fail(status === 401
      ? `Auth rejected (401) — check AGENT_KEY in .env`
      : `Cannot reach Laravel: ${err.message}`
    );
    failed++;
    console.log("\n  Stopping — cannot continue without Laravel connection.");
    process.exit(1);
  }

  // ── Test 2: Poll for jobs ─────────────────────────────────────────────────
  console.log("\n2. Polling for pending jobs...");
  try {
    const res  = await http.get("/api/agent/jobs", {
      params: { agent_id: "test-script" },
    });
    const jobs = res.data.jobs || [];
    ok(`Poll successful — ${jobs.length} pending job(s)`);
    if (jobs.length > 0) {
      info(`First job: #${jobs[0].id} · ${jobs[0].printer_type} · ${jobs[0].content_type}`);
    }
    passed++;
  } catch (err) {
    fail(`Poll failed: ${err.message}`);
    failed++;
  }

  // ── Test 3: Local printer registry ───────────────────────────────────────
  console.log("\n3. Local printer registry...");
  const printers = registry.list();
  if (printers.length === 0) {
    fail("No printers assigned — open http://localhost:3001 to assign printers");
    failed++;
  } else {
    ok(`${printers.length} printer(s) in registry`);
    printers.forEach(p => {
      info(`  ${p.id} → ${p.connection === "usb" ? p.device : `${p.ip}:${p.port}`} (${p.label})`);
    });
    passed++;
  }

  // ── Test 4: Printer connectivity ─────────────────────────────────────────
  if (printers.length > 0) {
    console.log("\n4. Printer connectivity (test print)...");
    for (const p of printers) {
      if (p.connection !== "network") {
        info(`${p.id} is USB — skipping TCP test`);
        continue;
      }
      try {
        await sendTestPrint(p.ip, p.port, `Agent Test — ${p.label}`);
        ok(`${p.id} (${p.ip}:${p.port}) — test page printed`);
        passed++;
      } catch (err) {
        fail(`${p.id} (${p.ip}:${p.port}) — ${err.message}`);
        failed++;
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(50));
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  console.log("=".repeat(50));

  if (failed === 0) {
    console.log("\n  Agent is ready. Start with: npm start\n");
  } else {
    console.log("\n  Fix the issues above, then run this test again.\n");
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error("Test script error:", err.message);
  process.exit(1);
});
