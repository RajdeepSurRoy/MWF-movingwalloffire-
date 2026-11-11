# The public MWF demo: one image with the MWF firewall API, the FreshCart shop, the Errand agent
# and the Playground page in front of them. Only the Playground's port (8080) is served; the
# firewall (8787) and the shop (3100, lookalike 3101) are reachable only inside the container.
#
# Built by Cloudflare (Workers Builds) from deploy/cloudflare/wrangler.jsonc, or by any Docker host:
#   docker build -t mwf-demo . && docker run -p 8080:8080 mwf-demo
FROM node:24-bookworm-slim

# Native modules (FreshCart's better-sqlite3) may need a compiler if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_fund=false \
    npm_config_audit=false

WORKDIR /app
COPY . .

# Dependencies: the MWF workspace (dev tools included: the apps run TypeScript through tsx),
# then each example app on its own.
RUN npm ci \
 && npm ci --prefix examples/freshcart \
 && npm ci --prefix examples/errand

# Chromium and its system libraries, for MWF's page check and for the agent's browser. Both use
# Playwright 1.64.1, so they share one browser build.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# The shop runs as a production build; the sensor model is fetched and hash-checked now, so the
# running container needs no Internet access.
RUN cd examples/freshcart && npx next build
RUN npx tsx examples/playground/preload-model.ts

# Run as an unprivileged user. Chromium runs without its own OS sandbox here (no user
# namespaces in the container); the container itself is the boundary, and it only ever opens
# the demo's own shop pages.
RUN useradd --create-home --uid 10001 mwf \
 && mkdir -p /app/examples/errand/data /tmp/mwf-playground \
 && chown -R mwf:mwf /app/examples/errand/data /app/examples/freshcart/.next /tmp/mwf-playground
USER mwf

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SHOP_MODE=start \
    DATA_DIR=/tmp/mwf-playground \
    MWF_RENDER_SANDBOX=off \
    MWF_SENSORS_DOWNLOAD=0 \
    BROWSER_CHANNEL=chromium

EXPOSE 8080
CMD ["node", "examples/playground/server.mjs"]
