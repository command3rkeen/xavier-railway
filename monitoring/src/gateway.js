/**
 * Persistent WebSocket RPC client for OpenClaw gateway.
 *
 * Connects to Xavier's gateway at ws://<host>:<port>, completes the
 * protocol-v3 handshake with token auth, and exposes a simple
 * `call(method, params)` → Promise<payload> interface.
 *
 * Auto-reconnects on close/error with exponential backoff (1s → 30s).
 */

import { randomUUID, createPrivateKey, sign } from "node:crypto";
import { EventEmitter } from "node:events";

const GATEWAY_HOST = process.env.XAVIER_TAILSCALE_HOST || "xavier";
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT) || 18789;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const GATEWAY_DEVICE_ID = process.env.GATEWAY_DEVICE_ID || "";
const GATEWAY_DEVICE_TOKEN = process.env.GATEWAY_DEVICE_TOKEN || "";
const GATEWAY_DEVICE_PUBKEY = process.env.GATEWAY_DEVICE_PUBKEY || "";
const GATEWAY_DEVICE_PRIVKEY = process.env.GATEWAY_DEVICE_PRIVKEY || "";

// ED25519 PKCS8 DER prefix (16 bytes) for wrapping raw 32-byte private keys
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Build the device-auth payload string that gets ED25519-signed.
 * Must match OpenClaw's buildDeviceAuthPayload() exactly.
 */
function buildDeviceAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
  const version = nonce ? "v2" : "v1";
  const parts = [version, deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), token || ""];
  if (version === "v2") parts.push(nonce);
  return parts.join("|");
}

/**
 * Sign the payload with the device's ED25519 private key.
 */
function signPayload(privKeyBase64Url, payload) {
  const privRaw = Buffer.from(privKeyBase64Url, "base64url");
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, privRaw]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

class GatewayClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._connected = false;
    this._handshakeComplete = false;
    this._pending = new Map();      // id → { resolve, reject, timer }
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._connectedAt = null;
    this._serverInfo = null;
  }

  // --- Public API ---

  connect() {
    this._doConnect();
  }

  isConnected() {
    return this._connected && this._handshakeComplete;
  }

  status() {
    return {
      connected: this.isConnected(),
      connectedAt: this._connectedAt,
      uptime: this._connectedAt ? Date.now() - this._connectedAt : 0,
      server: this._serverInfo,
      pendingCalls: this._pending.size,
    };
  }

  /**
   * Make an RPC call to the gateway.
   * @param {string} method - RPC method name (e.g. "sessions.list")
   * @param {object} params - Method parameters
   * @returns {Promise<any>} Response payload
   */
  async call(method, params = {}) {
    if (!this.isConnected()) {
      throw new Error(`Gateway not connected (calling ${method})`);
    }

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Gateway RPC timeout: ${method} (${CALL_TIMEOUT_MS}ms)`));
      }, CALL_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });

      this._send({
        type: "req",
        id,
        method,
        params,
      });
    });
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._connected = false;
    this._handshakeComplete = false;
  }

  // --- Internal ---

  _doConnect() {
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }

    const url = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;
    console.log(`[gateway] connecting to ${url}...`);

    try {
      this._ws = new WebSocket(url);
    } catch (err) {
      console.error("[gateway] WebSocket constructor error:", err.message);
      this._scheduleReconnect();
      return;
    }

    // Handshake timeout — if we don't complete handshake in time, reconnect
    const handshakeTimer = setTimeout(() => {
      if (!this._handshakeComplete) {
        console.error("[gateway] handshake timeout");
        this._ws?.close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    this._ws.onopen = () => {
      this._connected = true;
      this._reconnectDelay = RECONNECT_BASE_MS;
      console.log("[gateway] socket open, waiting for challenge...");
    };

    this._ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch (err) {
        console.error("[gateway] invalid JSON:", err.message);
        return;
      }

      // Handle connect.challenge event → send connect request
      if (msg.type === "event" && msg.event === "connect.challenge") {
        this._sendConnectRequest(msg.payload?.nonce);
        return;
      }

      // Handle response frames
      if (msg.type === "res") {
        // Special case: handshake response
        if (!this._handshakeComplete && msg.payload?.type === "hello-ok") {
          clearTimeout(handshakeTimer);
          this._handshakeComplete = true;
          this._connectedAt = Date.now();
          this._serverInfo = msg.payload.server || null;
          console.log(`[gateway] connected (protocol v${msg.payload.protocol}, server ${this._serverInfo?.version || "?"})`);
          this.emit("connected", msg.payload);
          // Resolve the handshake pending call if any
          const pending = this._pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(msg.id);
            pending.resolve(msg.payload);
          }
          return;
        }

        // Handshake error
        if (!this._handshakeComplete && msg.ok === false) {
          clearTimeout(handshakeTimer);
          console.error("[gateway] handshake failed:", msg.error?.message || JSON.stringify(msg.error));
          const pending = this._pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(msg.id);
            pending.reject(new Error(msg.error?.message || "Handshake failed"));
          }
          this._ws?.close();
          return;
        }

        // Normal RPC response
        const pending = this._pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this._pending.delete(msg.id);
          if (msg.ok) {
            pending.resolve(msg.payload);
          } else {
            const err = new Error(msg.error?.message || "RPC error");
            err.code = msg.error?.code;
            err.details = msg.error?.details;
            pending.reject(err);
          }
        }
        return;
      }

      // Handle server events (presence, agent status, etc.)
      if (msg.type === "event") {
        this.emit("event", msg);
      }
    };

    this._ws.onclose = (event) => {
      clearTimeout(handshakeTimer);
      const wasConnected = this._handshakeComplete;
      this._connected = false;
      this._handshakeComplete = false;
      this._connectedAt = null;
      this._serverInfo = null;

      // Reject all pending calls
      for (const [id, entry] of this._pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Gateway connection closed"));
      }
      this._pending.clear();

      if (wasConnected) {
        console.log(`[gateway] disconnected (code=${event.code})`);
        this.emit("disconnected");
      }

      this._scheduleReconnect();
    };

    this._ws.onerror = (err) => {
      // onclose will fire after this, which handles reconnect
      console.error("[gateway] socket error:", err.message || "unknown");
    };
  }

  _sendConnectRequest(nonce) {
    const id = randomUUID();

    // Set up a pending entry for the handshake response
    const timer = setTimeout(() => {
      this._pending.delete(id);
      console.error("[gateway] connect request timeout");
      this._ws?.close();
    }, HANDSHAKE_TIMEOUT_MS);

    this._pending.set(id, {
      resolve: () => {},  // Handled in onmessage hello-ok path
      reject: (err) => console.error("[gateway] connect rejected:", err.message),
      timer,
    });

    // When device credentials + private key are set, authenticate as a
    // paired device with ED25519-signed challenge to get operator scopes.
    // Otherwise fall back to basic gateway token auth (limited scopes).
    const useDeviceAuth = GATEWAY_DEVICE_ID && GATEWAY_DEVICE_TOKEN && GATEWAY_DEVICE_PRIVKEY;

    const role = "operator";
    const scopes = ["operator.read", "operator.write", "operator.admin"];

    const connectParams = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        displayName: "xavier-monitor",
        version: "1.0.0",
        platform: "node",
        mode: "backend",
      },
      auth: {
        token: useDeviceAuth ? GATEWAY_DEVICE_TOKEN : (GATEWAY_TOKEN || undefined),
      },
    };

    if (useDeviceAuth) {
      const signedAt = Date.now();

      // Build the payload string and sign it (matches OpenClaw's verification)
      const payload = buildDeviceAuthPayload({
        deviceId: GATEWAY_DEVICE_ID,
        clientId: "gateway-client",
        clientMode: "backend",
        role,
        scopes,
        signedAtMs: signedAt,
        token: GATEWAY_DEVICE_TOKEN,
        nonce: nonce || undefined,
      });
      const signature = signPayload(GATEWAY_DEVICE_PRIVKEY, payload);

      connectParams.device = {
        id: GATEWAY_DEVICE_ID,
        publicKey: GATEWAY_DEVICE_PUBKEY,
        signature,
        signedAt,
        nonce: nonce || undefined,
      };
      connectParams.role = role;
      connectParams.scopes = scopes;
    }

    this._send({
      type: "req",
      id,
      method: "connect",
      params: connectParams,
    });
  }

  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;

    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);

    console.log(`[gateway] reconnecting in ${delay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doConnect();
    }, delay);
  }
}

// Singleton instance
const gateway = new GatewayClient();

export default gateway;
