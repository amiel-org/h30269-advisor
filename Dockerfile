FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY cloudflare ./cloudflare
COPY static ./static
COPY config.json ./
COPY hs300/config.json ./hs300/config.json
COPY portfolio/config.json ./portfolio/config.json
COPY portfolio/reports/results.json ./portfolio/reports/results.json
RUN node cloudflare/build.mjs

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    TIME_ZONE=Asia/Shanghai \
    PORT=8789 \
    DATA_DIR=/data
COPY --from=build --chown=1000:1000 /app/cloudflare ./cloudflare
COPY --from=build --chown=1000:1000 /app/cloudflare-dist ./cloudflare-dist
COPY --from=build --chown=1000:1000 /app/config.json ./
COPY --from=build --chown=1000:1000 /app/hs300/config.json ./hs300/config.json
COPY --from=build --chown=1000:1000 /app/portfolio/config.json ./portfolio/config.json
COPY --from=build --chown=1000:1000 /app/portfolio/reports/results.json ./portfolio/reports/results.json
COPY --chown=1000:1000 server.mjs ./
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8789
CMD ["node", "server.mjs"]
