import express from "express";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as db from "./db.js";
import { collectHealth, collectLogs, collectDebug } from "./collector.js";
import { evaluate, sendTestAlert } from "./alerter.js";
import gateway from "./gateway.js";

const PORT = Number(process.env.PORT) || 9090;
const HEALTH_INTERVAL = Number(process.env.HEALTH_INTERVAL_MS) || 30_000;
const LOG_INTERVAL = Number(process.env.LOG_INTERVAL_MS) || 60_000;
const DEBUG_INTERVAL = Number(process.env.DEBUG_INTERVAL_MS) || 300_000;
const PRUNE_INTERVAL = Number(process.env.PRUNE_INTERVAL_MS) || 3_600_000;

const MONITOR_USERNAME = process.env.MONITOR_USERNAME || "admin";
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD;

const TS_AUTHKEY = process.env.TS_AUTHKEY;
const TS_HOSTNAME = process.env.TS_HOSTNAME || "xavier-monitor";
const TS_STATE_DIR = "/data/tailscale";
const TS_SOCKET = path.join(TS_STATE_DIR, "tailscaled.sock");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Tailscale ---

async function startTailscale() {
  if (!TS_AUTHKEY) {
    console.log("[tailscale] TS_AUTHKEY not set, skipping Tailscale");
    return;
  }

  fs.mkdirSync(TS_STATE_DIR, { recursive: true });

  // Start tailscaled in background (userspace networking, no tun device needed)
  const daemon = execFile("tailscaled", [
    "--tun=userspace-networking",
    "--statedir", TS_STATE_DIR,
    "--socket", TS_SOCKET,
  ], { stdio: "inherit" });
  daemon.unref();
  daemon.on("error", (err) => console.error("[tailscale] daemon error:", err.message));

  // Wait for socket
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(TS_SOCKET)) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Join tailnet
  const up = await runCmd("tailscale", [
    "--socket", TS_SOCKET,
    "up", "--authkey", TS_AUTHKEY, "--hostname", TS_HOSTNAME,
  ]);
  console.log(`[tailscale] up: exit=${up.code}`);

  // Serve the monitor on HTTPS via Tailscale
  const serve = await runCmd("tailscale", [
    "--socket", TS_SOCKET,
    "serve", "--bg",
    `http://localhost:${PORT}`,
  ]);
  console.log(`[tailscale] serve: exit=${serve.code}`);
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, output: stdout + stderr });
    });
  });
}

// --- Auth middleware ---

function requireAuth(req, res, next) {
  // /healthz is always public (Railway health check)
  if (req.path === "/healthz") return next();

  if (!MONITOR_PASSWORD) {
    // No password configured — allow access (dev mode)
    return next();
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Xavier Monitor"');
    return res.status(401).send("Auth required");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (user === MONITOR_USERNAME && pass === MONITOR_PASSWORD) {
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Xavier Monitor"');
  return res.status(401).send("Invalid credentials");
}

// --- SSE ---

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// --- Express app ---

const app = express();
app.use(express.json());
app.use(requireAuth);

// Public health check for Railway
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Dashboard HTML
const dashboardPath = path.join(__dirname, "dashboard.html");
app.get("/", (_req, res) => {
  res.type("html").send(fs.readFileSync(dashboardPath, "utf8"));
});

// SSE stream
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));

  // Send initial state
  const stats = db.getStats();
  const latest = db.getLatestHealth(1);
  res.write(`event: health\ndata: ${JSON.stringify({ stats, latest: latest[0] || null })}\n\n`);
});

// API: current stats
app.get("/api/stats", (_req, res) => {
  res.json(db.getStats());
});

// API: health history for sparklines
app.get("/api/health", (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  res.json(db.getRecentHealth(hours));
});

// API: uptime heatmap
app.get("/api/heatmap", (_req, res) => {
  res.json(db.getUptimeHeatmap());
});

// API: recent alerts
app.get("/api/alerts", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json(db.getRecentAlerts(limit));
});

// API: recent log probes
app.get("/api/logs", (req, res) => {
  const hours = Math.min(24, Math.max(1, Number(req.query.hours) || 1));
  res.json(db.getRecentLogProbes(hours));
});

// API: latest debug snapshot
app.get("/api/debug", (_req, res) => {
  res.json(db.getLatestDebug() || {});
});

// API: simple status for external checks
app.get("/api/status", (_req, res) => {
  const latest = db.getLatestHealth(1);
  const entry = latest[0];
  res.json({
    up: entry ? Boolean(entry.up) : null,
    gatewayReachable: entry ? Boolean(entry.gateway_reachable) : null,
    responseTimeMs: entry?.response_time_ms ?? null,
    lastCheck: entry?.ts ?? null,
  });
});

// API: send test alert
app.post("/api/test-alert", async (_req, res) => {
  const result = await sendTestAlert();
  res.json(result);
});

// --- Gateway proxy routes ---

// Gateway connection status
app.get("/api/gateway-status", (_req, res) => {
  res.json(gateway.status());
});

// List sessions
app.get("/api/sessions", async (req, res) => {
  try {
    const params = {
      limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)),
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    if (req.query.search) params.search = String(req.query.search);
    if (req.query.label) params.label = String(req.query.label);

    const result = await gateway.call("sessions.list", params);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Get chat history for a session
app.get("/api/sessions/:key/history", async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const result = await gateway.call("chat.history", {
      sessionKey: req.params.key,
      limit,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// List workspace files
app.get("/api/files", async (_req, res) => {
  try {
    const result = await gateway.call("agents.files.list", { agentId: "main" });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Get a single workspace file
app.get("/api/files/:name", async (req, res) => {
  try {
    const result = await gateway.call("agents.files.get", {
      agentId: "main",
      name: req.params.name,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Save a workspace file
app.put("/api/files/:name", async (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }
    const result = await gateway.call("agents.files.set", {
      agentId: "main",
      name: req.params.name,
      content,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Get gateway config
app.get("/api/config", async (_req, res) => {
  try {
    const result = await gateway.call("config.get", {});
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Memory search via Xavier's console API
app.get("/api/memory-search", async (req, res) => {
  try {
    const query = String(req.query.q || "");
    if (!query) return res.status(400).json({ error: "q parameter required" });

    const tsUrl = process.env.XAVIER_TAILSCALE_URL;
    const setupPw = process.env.SETUP_PASSWORD;
    if (!tsUrl || !setupPw) {
      return res.status(503).json({ error: "Xavier Tailscale URL or SETUP_PASSWORD not configured" });
    }

    const resp = await fetch(`${tsUrl}/setup/api/console/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from("admin:" + setupPw).toString("base64"),
      },
      body: JSON.stringify({ cmd: "openclaw.memory.search", arg: query }),
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Collection loops ---

async function healthLoop() {
  try {
    const result = await collectHealth();
    db.insertHealth(result);

    const alerts = await evaluate(result, null);
    const stats = db.getStats();

    broadcast("health", { stats, latest: result, alerts });
  } catch (err) {
    console.error("[health-loop] error:", err);
  }
}

async function logLoop() {
  try {
    const result = await collectLogs();
    db.insertLogProbe(result);

    const alerts = await evaluate(null, result);

    broadcast("logs", { latest: result, alerts });
  } catch (err) {
    console.error("[log-loop] error:", err);
  }
}

async function debugLoop() {
  try {
    const result = await collectDebug();
    if (result) {
      db.insertDebug(result);
      broadcast("debug", result);
    }
  } catch (err) {
    console.error("[debug-loop] error:", err);
  }
}

// --- Start ---

async function main() {
  console.log("[xavier-monitor] starting...");

  // Ensure data directory exists
  const dataDir = path.dirname(process.env.DB_PATH || "/data/xavier-monitor.db");
  fs.mkdirSync(dataDir, { recursive: true });

  // Init database
  db.init();
  console.log("[xavier-monitor] database initialized");

  // Start Tailscale
  await startTailscale();

  // Connect to Xavier's gateway WebSocket
  gateway.connect();
  gateway.on("connected", (info) => {
    console.log(`[xavier-monitor] gateway connected (${info.server?.version || "?"})`);
  });
  gateway.on("disconnected", () => {
    console.log("[xavier-monitor] gateway disconnected, will reconnect...");
  });

  // Start Express
  app.listen(PORT, () => {
    console.log(`[xavier-monitor] dashboard at http://localhost:${PORT}`);
  });

  // Start collection loops
  healthLoop(); // Run immediately, then on interval
  setInterval(healthLoop, HEALTH_INTERVAL);

  setTimeout(logLoop, 5_000); // Stagger start by 5s
  setInterval(logLoop, LOG_INTERVAL);

  setTimeout(debugLoop, 10_000); // Stagger start by 10s
  setInterval(debugLoop, DEBUG_INTERVAL);

  // Prune old data hourly
  setInterval(() => db.prune(), PRUNE_INTERVAL);

  console.log(`[xavier-monitor] probes started (health=${HEALTH_INTERVAL}ms, logs=${LOG_INTERVAL}ms, debug=${DEBUG_INTERVAL}ms)`);
}

main().catch((err) => {
  console.error("[xavier-monitor] fatal:", err);
  process.exit(1);
});
