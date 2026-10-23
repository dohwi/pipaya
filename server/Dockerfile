# pipaya server, sandbox image.
# Build context is server/ (see ../compose.yaml).
FROM oven/bun:1.3-debian

# Tools the agent's bash/grep tools expect. Add more here if your projects need them.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Unprivileged user. The image ships /data and /workspace owned by it so named volumes start writable.
RUN useradd --create-home --uid 10001 --shell /bin/bash pipaya \
	&& mkdir -p /app /data /workspace \
	&& chown pipaya:pipaya /app /data /workspace \
	&& chmod 700 /data

WORKDIR /app
USER pipaya

COPY --chown=pipaya:pipaya package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=pipaya:pipaya src ./src
COPY --chown=pipaya:pipaya builtin-skills ./builtin-skills
COPY --chown=pipaya:pipaya tsconfig.json ./

ENV PIPAYA_HOST=0.0.0.0 \
	PIPAYA_PORT=8787 \
	PIPAYA_DATA_DIR=/data \
	PIPAYA_WORKSPACE=/workspace

VOLUME ["/data", "/workspace"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PIPAYA_PORT}/health`); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "src/index.ts"]
