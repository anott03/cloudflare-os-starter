FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.3.1 AS computerd
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates git python3 python3-venv build-essential \
 && corepack enable && corepack prepare pnpm@11.17.0 --activate \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/computer-browsers
RUN mkdir -p /opt/computer-browser \
 && pnpm --dir /opt/computer-browser add --save-exact playwright@1.63.0 \
 && pnpm --dir /opt/computer-browser exec playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/*
COPY browser/screenshot.ts /opt/computer-browser/screenshot.mts

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
ENV GIT_TERMINAL_PROMPT=0
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
