const XAVIER_URL = process.env.XAVIER_URL;
const XAVIER_TAILSCALE_URL = process.env.XAVIER_TAILSCALE_URL;
const SETUP_PASSWORD = process.env.SETUP_PASSWORD;
const HEALTH_TIMEOUT_MS = 10_000;

const setupAuthHeader = SETUP_PASSWORD
  ? "Basic " + Buffer.from(`admin:${SETUP_PASSWORD}`).toString("base64")
  : null;

// --- Health Probe ---

export async function collectHealth() {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const res = await fetch(`${XAVIER_URL}/healthz`, { signal: controller.signal });
    clearTimeout(timer);

    const elapsed = Date.now() - start;
    const body = await res.json();

    return {
      up: true,
      responseTimeMs: elapsed,
      httpStatus: res.status,
      gatewayReachable: body.gateway?.reachable ?? null,
      gatewayLastError: body.gateway?.lastError ?? null,
      gatewayLastExit: body.gateway?.lastExit ?? null,
      tailscaleRunning: body.tailscale?.running ?? null,
      wrapperConfigured: body.wrapper?.configured ?? null,
    };
  } catch (err) {
    return {
      up: false,
      responseTimeMs: Date.now() - start,
      httpStatus: 0,
      gatewayReachable: null,
      gatewayLastError: err.message,
      gatewayLastExit: null,
      tailscaleRunning: null,
      wrapperConfigured: null,
    };
  }
}

// --- Log Probe ---

const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bERROR\b/,
  /\[error\]/i,
  /\[gateway\] spawn error/,
  /\[gateway\] exited/,
  /Cannot read properties of null/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /unhandled/i,
];

const RESTART_PATTERNS = [
  /\[gateway\] exited code=/,
  /\[gateway\] spawn error/,
  /\[gateway\] starting/,
];

export async function collectLogs() {
  const baseUrl = XAVIER_TAILSCALE_URL || XAVIER_URL;
  if (!setupAuthHeader) {
    return { errorCount: 0, restartDetected: false, rawSnippet: null, skipped: true };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(`${baseUrl}/setup/api/console/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: setupAuthHeader,
      },
      body: JSON.stringify({ cmd: "openclaw.logs.tail", arg: "100" }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { errorCount: 0, restartDetected: false, rawSnippet: `HTTP ${res.status}`, skipped: false };
    }

    const body = await res.json();
    const output = body.output || "";
    const lines = output.split("\n");

    let errorCount = 0;
    let restartDetected = false;
    const errorLines = [];

    for (const line of lines) {
      const isError = ERROR_PATTERNS.some(p => p.test(line));
      if (isError) {
        errorCount++;
        if (errorLines.length < 10) errorLines.push(line.slice(0, 200));
      }
      if (!restartDetected && RESTART_PATTERNS.some(p => p.test(line))) {
        restartDetected = true;
      }
    }

    return {
      errorCount,
      restartDetected,
      rawSnippet: errorLines.length > 0 ? errorLines.join("\n").slice(0, 2000) : null,
      skipped: false,
    };
  } catch (err) {
    console.error("[collector] log probe error:", err.message);
    return { errorCount: 0, restartDetected: false, rawSnippet: `probe error: ${err.message}`, skipped: false };
  }
}

// --- Debug Probe ---

export async function collectDebug() {
  const baseUrl = XAVIER_TAILSCALE_URL || XAVIER_URL;
  if (!setupAuthHeader) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(`${baseUrl}/setup/api/debug`, {
      headers: { Authorization: setupAuthHeader },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const body = await res.json();
    return {
      gatewayLastError: body.wrapper?.lastGatewayError || null,
      gatewayLastExit: body.wrapper?.lastGatewayExit ? JSON.stringify(body.wrapper.lastGatewayExit) : null,
      lastDoctorAt: body.wrapper?.lastDoctorAt || null,
      openclawVersion: body.openclaw?.version || null,
    };
  } catch (err) {
    console.error("[collector] debug probe error:", err.message);
    return null;
  }
}
