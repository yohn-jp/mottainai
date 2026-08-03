# Mottainai

**Mottainai** ("wasteful" / "what a waste" in Japanese) is a proxy gateway
that sits between an LLM client and one or more upstream
[MCP](https://modelcontextprotocol.io/) servers, and **compresses tool
definitions and tool call results before they reach the model context**.

> **Status: pre-1.0 (`0.x`).** This repository is being imported from a
> private predecessor in a series of small, dependency-ordered PRs so each
> one stays reviewable and keeps the build green. This first PR is the
> foundation layer only (compression primitives, envelope/logging/telemetry,
> state-store basics) — the proxy, upstream connections, and CLI entry point
> land in follow-up PRs. Full architecture docs land once the pieces they
> describe exist in this repo.

## How it fits together

```text
                 ┌───────────────────────────┐
  LLM client  ⇄  │         mottainai          │  ⇄  upstream MCP servers
 (Claude Code,   │  (this project, one stdio  │     (codegraph, fff-mcp,
  Codex, etc.)   │      MCP endpoint)         │      GitHub MCP, ...)
                 └───────────────────────────┘
```

Every upstream tool will be exposed under a prefixed name
(`<upstream>__<tool>`) to avoid collisions. Tool call results pass through a
compression pipeline before being returned to the client; the pre-compression
original is kept for a short time and can be retrieved on demand instead of
being lost.

## Installation

Requires Node.js >= 22.13, [pnpm](https://pnpm.io/) 11.18.0, and
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on `PATH`.

```bash
git clone https://github.com/yohn-jp/mottainai.git
cd mottainai
pnpm install
pnpm run build
```

## Development

```bash
pnpm install
pnpm run build          # tsc -> dist/
pnpm test                # node --import tsx --test "src/**/*.test.ts"
pnpm run typecheck       # tsc --noEmit
```

## License

[MIT](LICENSE)
