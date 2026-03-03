/**
 * vault-auth-proxy.js — HTTP proxy enforcing vault ACLs via Tailscale identity.
 *
 * Sits in front of SilverBullet to enforce per-path access control based on the
 * Tailscale user identity header. Tailscale's serve sets `Tailscale-User-Login`
 * when proxying authenticated requests.
 *
 * Access rules:
 *   company/**     → all authenticated users (read + write)
 *   xavier/**      → admin users only (from VAULT_ADMIN_USERS env)
 *   personal/{u}/* → only the matching user (auto-creates dir on first access)
 *
 * Environment:
 *   VAULT_ADMIN_USERS  — Comma-separated Tailscale logins for admin access
 *   SB_PORT            — SilverBullet backend port (default: 9093)
 *   PROXY_PORT         — Port this proxy listens on (default: 9094)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const VAULT_ADMIN_USERS = new Set(
  (process.env.VAULT_ADMIN_USERS || "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean),
);

const SB_PORT = Number.parseInt(process.env.SB_PORT ?? "9093", 10);
const PROXY_PORT = Number.parseInt(process.env.PROXY_PORT ?? "9094", 10);
const VAULT_DIR = process.env.VAULT_DIR?.trim() || "/data/vault";
const SB_HOST = "127.0.0.1";

function log(msg) {
  console.log(`[vault-auth-proxy] ${msg}`);
}

/**
 * Extract the Tailscale user login from the request headers.
 * Returns the lowercase email/login or null if unauthenticated.
 */
function getTailscaleUser(req) {
  const header = req.headers["tailscale-user-login"];
  return header ? header.trim().toLowerCase() : null;
}

/**
 * Derive a short username from a Tailscale login (email).
 * e.g., "ron@g2xchange.com" → "ron"
 */
function usernameFromLogin(login) {
  return login.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Check if a user is an admin.
 */
function isAdmin(login) {
  return VAULT_ADMIN_USERS.has(login);
}

/**
 * Determine if the user is allowed to access the given vault path.
 * @param {string} login   — Tailscale user login (email)
 * @param {string} urlPath — The URL path being requested
 * @returns {{allowed: boolean, reason?: string}}
 */
function checkAccess(login, urlPath) {
  // Normalize: remove leading slash, decode
  const normalized = decodeURIComponent(urlPath).replace(/^\/+/, "");

  // SilverBullet internal routes (API, assets, etc.) — allow through
  if (
    normalized.startsWith(".") ||
    normalized.startsWith("_") ||
    normalized.startsWith("plug/") ||
    normalized.startsWith("!") ||
    normalized === "" ||
    normalized === "index.html"
  ) {
    return { allowed: true };
  }

  // company/** → all authenticated users
  if (normalized.startsWith("company/") || normalized === "company") {
    return { allowed: true };
  }

  // xavier/** → admin only
  if (normalized.startsWith("xavier/") || normalized === "xavier") {
    if (isAdmin(login)) {
      return { allowed: true };
    }
    return { allowed: false, reason: "xavier/ is restricted to admins" };
  }

  // personal/** → scoped to own directory
  if (normalized.startsWith("personal/")) {
    const username = usernameFromLogin(login);
    const allowedPrefix = `personal/${username}`;
    if (normalized.startsWith(allowedPrefix + "/") || normalized === allowedPrefix) {
      // Auto-create the personal directory if it doesn't exist
      const personalDir = path.join(VAULT_DIR, "personal", username);
      if (!fs.existsSync(personalDir)) {
        fs.mkdirSync(personalDir, { recursive: true });
        log(`created personal directory for ${username}`);
      }
      return { allowed: true };
    }
    // Admins can see all personal directories
    if (isAdmin(login)) {
      return { allowed: true };
    }
    return { allowed: false, reason: "access limited to your own personal/ directory" };
  }

  // Root-level content (e.g., _index.md) — allow for all authenticated users
  return { allowed: true };
}

/**
 * Proxy a request to SilverBullet.
 */
function proxyToSilverBullet(req, res) {
  const options = {
    hostname: SB_HOST,
    port: SB_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${SB_HOST}:${SB_PORT}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    log(`proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway");
    }
  });

  req.pipe(proxyReq, { end: true });
}

const server = http.createServer((req, res) => {
  const login = getTailscaleUser(req);

  // No Tailscale identity = not on tailnet (shouldn't happen behind tailscale serve,
  // but guard anyway). Allow health checks through without auth.
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!login) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized: Tailscale identity required");
    return;
  }

  const { allowed, reason } = checkAccess(login, req.url);

  if (!allowed) {
    log(`denied ${login} access to ${req.url}: ${reason}`);
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end(`Forbidden: ${reason}`);
    return;
  }

  proxyToSilverBullet(req, res);
});

// Also handle WebSocket upgrades (SilverBullet uses them for live sync)
server.on("upgrade", (req, socket, _head) => {
  const login = getTailscaleUser(req);
  if (!login) {
    socket.destroy();
    return;
  }

  const { allowed } = checkAccess(login, req.url);
  if (!allowed) {
    socket.destroy();
    return;
  }

  const options = {
    hostname: SB_HOST,
    port: SB_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${SB_HOST}:${SB_PORT}` },
  };

  const proxyReq = http.request(options);

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );

    if (proxyHead.length > 0) socket.write(proxyHead);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", () => {
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PROXY_PORT} (proxying to SilverBullet on :${SB_PORT})`);
  log(`admin users: ${[...VAULT_ADMIN_USERS].join(", ") || "(none configured)"}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("shutting down...");
  server.close();
});
