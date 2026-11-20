# flop-doctor

Zero-dependency, read-only diagnostic watchdog CLI for **FLOP Network** miners, operators, and agents.

Requires **Node.js >= 22**. No third-party packages (`dependencies: {}`, `devDependencies: {}`), no `@polkadot/api`, no private keys, no `.env` reads, no disk writes.

## Why flop-doctor?

Standard Substrate/SDK tooling initializes `@polkadot/api` via `state_getMetadata` (~974 KB) with a short connect timeout (see `flop-labs/network#280`, `#420`). When the public RPC flaps or `state_getMetadata` returns 503/timeout, metadata-dependent tools hang or abort completely.

`flop-doctor` avoids metadata handshakes on the critical path:
- **Degrades cleanly during RPC flapping**: uses lightweight JSON-RPC calls (`system_health`, `chain_getBlockHash`, `chain_getFinalizedHead`, `chain_getHeader`) plus Explorer, Gateway, Faucet, and `releases.json` in parallel, while isolating `state_getMetadata` as a single 5s diagnostic probe.
- **Cross-source serviceability truth**: compares Gateway `/v1/models` against live Explorer `/api/session-offers` to flag models advertised with nominal capacity (`capacity_tpm`) that currently have zero valid standing offers.
- **Miner watchdog for slashing & uptime risk**: checks registration, active/blacklist status, strikes, slash history, total stake, worker build vs `releases.json`, calibration lease remaining blocks, spendable fee balance (exact BigInt planck arithmetic), standing offer health, reliability/Ghost counters, recent timed-out sessions, and direct public HTTPS endpoint probes (DNS public-IP / no-`.ts.net` / fake-IP guard, TLS expiry, unauthenticated `/session/info` 401 without redirects).
- **Cron & AI-agent ready**: deterministic JSON output validated against `schema/report.v1.schema.json`, Nagios-style exit codes, stable deduplication `fingerprint`, and `--redact` for safely attaching reports to public issues.

## Quickstart

No `npm install` needed:

```sh
# 1. Network health, 4-way genesis parity, finality lag, and state_getMetadata probe
node bin/flop-doctor.mjs net --verbose

# 2. Live catalog vs standing-offer serviceability (detect nominal capacity with 0 offers)
node bin/flop-doctor.mjs market --model qwen/qwen2.5-0.5b-instruct

# 3. Inspect a miner and its public HTTPS session endpoint (redacted JSON for issue reports)
node bin/flop-doctor.mjs miner <SS58_ADDRESS> --endpoint https://miner.example --json --redact

# 4. Full watchdog sweep across up to 8 miners (for cron / alerting)
node bin/flop-doctor.mjs check \
  --miner <MINER_1>=https://m1.example \
  --miner <MINER_2>=https://m2.example \
  --json

# Run the offline test suite (22 tests, zero network calls)
node --test
```

## Subcommands & Options

```text
flop-doctor net
flop-doctor market [--model <id|model_hash>]...
flop-doctor miner <ss58> [--endpoint https://<host>[:port]]
flop-doctor check [--miner <ss58>[=https://<host>[:port]]]... [--model <id|model_hash>]...
```

Key flags (run `--help` for full list):
- `--json` — emit a single `flop-doctor/report/v1` JSON document to stdout (errors emit `flop-doctor/error/v1`).
- `--redact` — replace miner SS58 addresses with `miner-N`, endpoints with `endpoint-N`, and mask sensitive `miner.*` / `endpoint.*` evidence before rendering and fingerprinting.
- `--verbose` — include `pass` checks in text output (hidden by default).
- `--timeout <seconds>` — global hard budget (default `20`, range `5–120`; single-request cap `5s`).
- `--min-fee-flop <decimal>` — minimum spendable fee balance threshold in FLOP (default `1`, exact up to 18 decimals).
- `--calib-warn-blocks` / `--calib-fail-blocks` — calibration lease remaining block thresholds (`7200` / `600`).
- `--cert-warn-days` / `--cert-fail-days` — TLS certificate remaining day thresholds (`14` / `3`).
- `--expect-genesis <0x...64hex>` — pin expected genesis hash to detect network resets.
- `--rpc`, `--explorer`, `--gateway`, `--faucet`, `--releases` — override default Devnet endpoints (HTTPS only, no userinfo).

## Exit Codes & Cause Attribution

Aggregation precedence: `fail > unknown > warn > pass`.

| Exit Code | Meaning |
|---:|---|
| `0` | All checks passed |
| `1` | Worst status is `warn` |
| `2` | At least one `fail` |
| `3` | No `fail`, at least one `unknown` (missing/stale data or budget exhausted) |
| `64` | Usage / validation error (invalid SS58 checksum, non-HTTPS URL, conflicting flags, etc.) |
| `70` | Internal error outside check execution |

Every non-pass check includes a closed `cause_class` (`upstream`, `market`, `operator`, `local`, `schema`, `budget`, `internal`) and stable 16-hex `fingerprint` (ignoring timestamps, block heights, and latencies so alert wrappers can deduplicate cleanly).

## Security & Network Boundaries

- **Zero secrets**: accepts only public SS58 addresses and HTTPS URLs; never reads `.env`, keystores, or `Authorization` headers; ships zero third-party dependencies so the full source can be audited directly on operator hosts.
- **Read-only & bounded**: sends only HTTP `GET` and read-only JSON-RPC `POST`, no retries, `redirect: 'manual'`, 8 MiB response size cap, deduplicated requests per run.
- **Direct endpoint probes**: miner endpoint checks resolve DNS directly, reject IP literals, `.ts.net`, and private/CGNAT/loopback/link-local/mapped-IPv4 ranges, flag `198.18.0.0/15` as `fake_ip_suspected`, pin TLS & `/session/info` connections to the verified IP with SNI, and require HTTP `401` (rejecting redirects and unauthenticated `200`).

## 中文简介

`flop-doctor` 是面向 FLOP Network 矿工与 Agent 的**纯 Node ≥22 零依赖只读诊断 CLI**。核心设计是绕开 `@polkadot/api` 元数据握手在公共 RPC 抖动时的 503/超时卡死，使用轻量化只读接口与索引器做跨源诊断（含目录与 standing offer 交集真相、矿工校准租约/手续费/版本/可靠性检查与公网 HTTPS 端点直连探针），提供固定 JSON Schema、Nagios 退出码、去重指纹与 `--redact` 脱敏。详细规格见 [SPEC.md](SPEC.md)。

## License

MIT — see [LICENSE](LICENSE).
