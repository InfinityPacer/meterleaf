FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html components.json ./
COPY src ./src
COPY public ./public
COPY prices ./prices
COPY tests ./tests
COPY scripts ./scripts
RUN bun run build

FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/prices ./prices
RUN mkdir -p /app/app_data && chown bun:bun /app/app_data
USER bun
ENV METERLEAF_HOST=0.0.0.0
ENV METERLEAF_PORT=4318
ENV METERLEAF_DATA_DIR=/app/app_data
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e 'const response = await fetch("http://127.0.0.1:4318/api/health"); process.exit(response.ok ? 0 : 1)'
CMD ["bun", "run", "start"]
