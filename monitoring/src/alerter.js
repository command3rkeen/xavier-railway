import { insertAlert } from "./db.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;

// Cooldowns in ms
const COOLDOWNS = {
  gateway_down: Number(process.env.ALERT_COOLDOWN_GATEWAY_DOWN_MS) || 900_000,       // 15 min
  gateway_unreachable: 900_000,
  high_error_rate: Number(process.env.ALERT_COOLDOWN_HIGH_ERROR_RATE_MS) || 1_800_000, // 30 min
  restart_detected: Number(process.env.ALERT_COOLDOWN_RESTART_MS) || 600_000,          // 10 min
  high_latency: Number(process.env.ALERT_COOLDOWN_HIGH_LATENCY_MS) || 1_800_000,
  tailscale_down: 3_600_000,                                                            // 60 min
};

const CONSECUTIVE_FAILURES = Number(process.env.CONSECUTIVE_FAILURES_THRESHOLD) || 3;
const HIGH_ERROR_THRESHOLD = Number(process.env.HIGH_ERROR_THRESHOLD) || 10;
const HIGH_LATENCY_MS = Number(process.env.HIGH_LATENCY_THRESHOLD_MS) || 5000;

// --- State ---

// Gateway state machine: UNKNOWN -> UP -> DOWN_1 -> DOWN_2 -> ALERTING
let gatewayState = "UNKNOWN";
let gatewayDownSince = null;
let consecutiveFailures = 0;
let consecutiveGatewayUnreachable = 0;
let consecutiveTailscaleDown = 0;
let lastTailscaleState = null;

// Cooldown tracking: ruleId -> last fired timestamp
const lastFired = new Map();

// Rolling latency buffer (last 5 health probes)
const latencyBuffer = [];

// --- Core evaluate function ---

export async function evaluate(healthResult, logResult) {
  const alerts = [];

  // --- Gateway down / recovered ---
  if (healthResult) {
    if (!healthResult.up) {
      consecutiveFailures++;
      if (consecutiveFailures >= CONSECUTIVE_FAILURES && gatewayState !== "ALERTING") {
        gatewayState = "ALERTING";
        gatewayDownSince = new Date(Date.now() - consecutiveFailures * 30_000).toISOString();
        alerts.push(await fireAlert("gateway_down", "critical",
          `Xavier Gateway Down\n\n` +
          `Unreachable for ${consecutiveFailures} consecutive probes (~${consecutiveFailures * 30}s).\n` +
          `Last HTTP status: ${healthResult.httpStatus}\n` +
          `Last error: ${healthResult.gatewayLastError || "connection failed"}\n` +
          `Since: ${gatewayDownSince}`
        ));
      }
    } else {
      // Xavier is up
      if (gatewayState === "ALERTING" && gatewayDownSince) {
        const downDuration = formatDuration(Date.now() - new Date(gatewayDownSince).getTime());
        // Recovery always fires (no cooldown)
        alerts.push(await fireAlert("gateway_recovered", "info",
          `Xavier Gateway Recovered\n\n` +
          `Back online after ${downDuration} of downtime.\n` +
          `Response time: ${healthResult.responseTimeMs}ms\n` +
          `Gateway reachable: ${healthResult.gatewayReachable ? "yes" : "no"}`,
          true // force send, skip cooldown
        ));
        // Reset cooldown for gateway_down so next incident alerts immediately
        lastFired.delete("gateway_down");
      }
      consecutiveFailures = 0;
      gatewayState = "UP";
      gatewayDownSince = null;

      // --- Gateway unreachable (up but gateway not reachable) ---
      if (healthResult.gatewayReachable === false) {
        consecutiveGatewayUnreachable++;
        if (consecutiveGatewayUnreachable >= CONSECUTIVE_FAILURES) {
          alerts.push(await fireAlert("gateway_unreachable", "warning",
            `Xavier Gateway Unreachable\n\n` +
            `Wrapper is responding but the OpenClaw gateway is not reachable.\n` +
            `Last error: ${healthResult.gatewayLastError || "unknown"}`
          ));
        }
      } else {
        consecutiveGatewayUnreachable = 0;
      }

      // --- Tailscale down ---
      if (healthResult.tailscaleRunning === false && lastTailscaleState === true) {
        consecutiveTailscaleDown++;
        if (consecutiveTailscaleDown >= CONSECUTIVE_FAILURES) {
          alerts.push(await fireAlert("tailscale_down", "warning",
            `Xavier Tailscale Down\n\nTailscale was running but is now offline.`
          ));
        }
      } else if (healthResult.tailscaleRunning === true) {
        consecutiveTailscaleDown = 0;
      }
      if (healthResult.tailscaleRunning != null) {
        lastTailscaleState = healthResult.tailscaleRunning;
      }

      // --- High latency ---
      latencyBuffer.push(healthResult.responseTimeMs);
      if (latencyBuffer.length > 5) latencyBuffer.shift();
      if (latencyBuffer.length >= 5) {
        const avg = latencyBuffer.reduce((a, b) => a + b, 0) / latencyBuffer.length;
        if (avg > HIGH_LATENCY_MS) {
          alerts.push(await fireAlert("high_latency", "warning",
            `Xavier High Latency\n\n` +
            `Average response time: ${Math.round(avg)}ms (threshold: ${HIGH_LATENCY_MS}ms)\n` +
            `Last 5 probes: ${latencyBuffer.join(", ")}ms`
          ));
        }
      }
    }
  }

  // --- Log-based alerts ---
  if (logResult && !logResult.skipped) {
    if (logResult.errorCount >= HIGH_ERROR_THRESHOLD) {
      alerts.push(await fireAlert("high_error_rate", "warning",
        `Xavier High Error Rate\n\n` +
        `${logResult.errorCount} errors detected in last log probe (threshold: ${HIGH_ERROR_THRESHOLD}).\n` +
        `${logResult.rawSnippet ? `Sample:\n${logResult.rawSnippet.slice(0, 500)}` : ""}`
      ));
    }

    if (logResult.restartDetected) {
      alerts.push(await fireAlert("restart_detected", "warning",
        `Xavier Gateway Restart Detected\n\n` +
        `Log probe detected a gateway restart event.\n` +
        `${logResult.rawSnippet ? `Context:\n${logResult.rawSnippet.slice(0, 500)}` : ""}`
      ));
    }
  }

  return alerts.filter(Boolean);
}

// --- Alert firing with cooldown ---

async function fireAlert(rule, severity, message, forceSend = false) {
  // Check cooldown
  if (!forceSend) {
    const last = lastFired.get(rule);
    const cooldown = COOLDOWNS[rule] || 900_000;
    if (last && Date.now() - last < cooldown) {
      return null; // Still in cooldown
    }
  }

  lastFired.set(rule, Date.now());

  // Send to Telegram
  let telegramSent = false;
  let telegramMessageId = null;

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_ALERT_CHAT_ID) {
    try {
      const result = await sendTelegramMessage(formatTelegramMessage(severity, message));
      telegramSent = result.ok;
      telegramMessageId = result.result?.message_id ? String(result.result.message_id) : null;
    } catch (err) {
      console.error("[alerter] Telegram send error:", err.message);
    }
  }

  // Store in DB
  const alertData = { rule, severity, message, telegramSent, telegramMessageId };
  insertAlert(alertData);

  console.log(`[alerter] ${severity.toUpperCase()}: ${rule} — telegram_sent=${telegramSent}`);
  return alertData;
}

// --- Telegram ---

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_ALERT_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  return res.json();
}

function formatTelegramMessage(severity, message) {
  const icon = severity === "critical" ? "\u{1F534}" // red circle
    : severity === "warning" ? "\u{1F7E1}" // yellow circle
    : "\u{1F7E2}"; // green circle
  return `${icon} <b>${severity.toUpperCase()}</b>\n\n${escapeHtml(message)}`;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Helpers ---

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

// --- Test utility ---

export async function sendTestAlert() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID not set" };
  }
  const result = await sendTelegramMessage(
    formatTelegramMessage("info", "Xavier Monitor — Test alert\n\nThis is a test. If you see this, alerting is working.")
  );
  return result;
}
