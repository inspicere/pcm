FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY src ./src
COPY tools ./tools
COPY vendor ./vendor

RUN mkdir -p /data/tenants && chown -R bun:bun /data

EXPOSE 3600
USER bun

CMD ["bun", "run", "src/index.ts"]
