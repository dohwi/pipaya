// Loaded by `bun test` (see ../bunfig.toml). The OpenRouter catalog is fetched live in production; tests get the
// snapshot bundled with pi-ai instead, so a run never depends on openrouter.ai being reachable.
process.env.PIPAYA_OPENROUTER = "0";
