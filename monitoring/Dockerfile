# --- Build stage: compile better-sqlite3 native addon ---
FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# --- Runtime stage ---
FROM node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
     -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
     -o /etc/apt/sources.list.d/tailscale.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tailscale \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pre-built node_modules (includes native better-sqlite3)
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=9090
EXPOSE 9090

CMD ["node", "src/server.js"]
