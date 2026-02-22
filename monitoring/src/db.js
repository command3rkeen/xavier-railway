import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "/data/xavier-monitor.db";

let db;

export function init() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const schema = `
    CREATE TABLE IF NOT EXISTS health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      up INTEGER NOT NULL,
      response_time_ms INTEGER NOT NULL,
      http_status INTEGER NOT NULL,
      gateway_reachable INTEGER,
      gateway_last_error TEXT,
      gateway_last_exit TEXT,
      tailscale_running INTEGER,
      wrapper_configured INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_health_ts ON health_checks(ts);

    CREATE TABLE IF NOT EXISTS log_probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      error_count INTEGER NOT NULL DEFAULT 0,
      restart_detected INTEGER NOT NULL DEFAULT 0,
      raw_snippet TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_ts ON log_probes(ts);

    CREATE TABLE IF NOT EXISTS debug_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      gateway_last_error TEXT,
      gateway_last_exit TEXT,
      last_doctor_at TEXT,
      openclaw_version TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_debug_ts ON debug_snapshots(ts);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      rule TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      telegram_sent INTEGER NOT NULL DEFAULT 0,
      telegram_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
    CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule);
  `;

  // Execute schema statements one at a time (better-sqlite3's exec handles multiple)
  for (const stmt of schema.split(";").map(s => s.trim()).filter(Boolean)) {
    db.prepare(stmt).run();
  }

  return db;
}

// --- Inserts ---

const _insertHealth = () => db.prepare(`
  INSERT INTO health_checks (up, response_time_ms, http_status, gateway_reachable,
    gateway_last_error, gateway_last_exit, tailscale_running, wrapper_configured)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

let insertHealthStmt;
export function insertHealth(data) {
  if (!insertHealthStmt) insertHealthStmt = _insertHealth();
  return insertHealthStmt.run(
    data.up ? 1 : 0,
    data.responseTimeMs,
    data.httpStatus,
    data.gatewayReachable == null ? null : data.gatewayReachable ? 1 : 0,
    data.gatewayLastError || null,
    data.gatewayLastExit ? JSON.stringify(data.gatewayLastExit) : null,
    data.tailscaleRunning == null ? null : data.tailscaleRunning ? 1 : 0,
    data.wrapperConfigured == null ? null : data.wrapperConfigured ? 1 : 0,
  );
}

const _insertLogProbe = () => db.prepare(`
  INSERT INTO log_probes (error_count, restart_detected, raw_snippet)
  VALUES (?, ?, ?)
`);

let insertLogProbeStmt;
export function insertLogProbe(data) {
  if (!insertLogProbeStmt) insertLogProbeStmt = _insertLogProbe();
  return insertLogProbeStmt.run(
    data.errorCount,
    data.restartDetected ? 1 : 0,
    data.rawSnippet || null,
  );
}

const _insertDebug = () => db.prepare(`
  INSERT INTO debug_snapshots (gateway_last_error, gateway_last_exit, last_doctor_at, openclaw_version)
  VALUES (?, ?, ?, ?)
`);

let insertDebugStmt;
export function insertDebug(data) {
  if (!insertDebugStmt) insertDebugStmt = _insertDebug();
  return insertDebugStmt.run(
    data.gatewayLastError || null,
    data.gatewayLastExit || null,
    data.lastDoctorAt || null,
    data.openclawVersion || null,
  );
}

const _insertAlert = () => db.prepare(`
  INSERT INTO alerts (rule, severity, message, telegram_sent, telegram_message_id)
  VALUES (?, ?, ?, ?, ?)
`);

let insertAlertStmt;
export function insertAlert(data) {
  if (!insertAlertStmt) insertAlertStmt = _insertAlert();
  return insertAlertStmt.run(
    data.rule,
    data.severity,
    data.message,
    data.telegramSent ? 1 : 0,
    data.telegramMessageId || null,
  );
}

// --- Queries ---

export function getRecentHealth(hours = 24) {
  return db.prepare(`
    SELECT * FROM health_checks
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    ORDER BY ts ASC
  `).all(`-${hours} hours`);
}

export function getLatestHealth(count = 5) {
  return db.prepare(`
    SELECT * FROM health_checks ORDER BY id DESC LIMIT ?
  `).all(count);
}

export function getRecentAlerts(limit = 50) {
  return db.prepare(`
    SELECT * FROM alerts ORDER BY ts DESC LIMIT ?
  `).all(limit);
}

export function getRecentLogProbes(hours = 1) {
  return db.prepare(`
    SELECT * FROM log_probes
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    ORDER BY ts DESC
  `).all(`-${hours} hours`);
}

export function getLatestDebug() {
  return db.prepare(`
    SELECT * FROM debug_snapshots ORDER BY id DESC LIMIT 1
  `).get();
}

export function getStats() {
  const uptime24h = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN up = 1 THEN 1 ELSE 0 END) as up_count
    FROM health_checks
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
  `).get();

  const latency = db.prepare(`
    SELECT response_time_ms FROM health_checks
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND up = 1
    ORDER BY response_time_ms ASC
  `).all();

  const errorRate = db.prepare(`
    SELECT COALESCE(SUM(error_count), 0) as total_errors, COUNT(*) as probe_count
    FROM log_probes
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
  `).get();

  // Compute percentiles from sorted latency array
  const times = latency.map(r => r.response_time_ms);
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  const p99 = percentile(times, 99);

  return {
    uptime24h: uptime24h.total > 0 ? (uptime24h.up_count / uptime24h.total * 100).toFixed(1) : null,
    totalChecks24h: uptime24h.total,
    latency: { p50, p95, p99, current: times.length > 0 ? times[times.length - 1] : null },
    errorRate: {
      totalErrors: errorRate.total_errors,
      probeCount: errorRate.probe_count,
    },
  };
}

// Uptime heatmap: one slot per 15 minutes over 7 days
export function getUptimeHeatmap() {
  return db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:', ts) ||
        CASE
          WHEN CAST(strftime('%M', ts) AS INTEGER) < 15 THEN '00'
          WHEN CAST(strftime('%M', ts) AS INTEGER) < 30 THEN '15'
          WHEN CAST(strftime('%M', ts) AS INTEGER) < 45 THEN '30'
          ELSE '45'
        END || ':00Z' as slot,
      COUNT(*) as total,
      SUM(CASE WHEN up = 1 AND gateway_reachable = 1 THEN 1 ELSE 0 END) as healthy
    FROM health_checks
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
    GROUP BY slot
    ORDER BY slot ASC
  `).all();
}

// --- Pruning ---

export function prune() {
  const result = {
    health: db.prepare("DELETE FROM health_checks WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')").run().changes,
    logs: db.prepare("DELETE FROM log_probes WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')").run().changes,
    debug: db.prepare("DELETE FROM debug_snapshots WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')").run().changes,
    alerts: db.prepare("DELETE FROM alerts WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')").run().changes,
  };
  if (result.health || result.logs || result.debug || result.alerts) {
    console.log("[db] pruned:", result);
  }
  return result;
}

// --- Helpers ---

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}
