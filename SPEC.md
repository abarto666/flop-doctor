# flop-doctor v1 工程规格定稿（Fable 5.2 评审 + Devnet 实时字段核验）

## 0. 不变量

- 纯 Node ≥22 ESM，`dependencies` 和 `devDependencies` 均为空，只用 `node:*` 和全局 `fetch`。不 import 父目录的 `@flop-labs/*`、`@polkadot/api`。
- 只读零密钥：只发 GET 和只读 JSON-RPC POST。不读 `secrets/`、`.env`，不带 `Authorization`，不写磁盘，无状态。
- 每个 URL 每次运行最多请求 1 次，不重试，`redirect: 'manual'`，响应体上限 8 MiB，所有请求在 t=0 并发发出。
- 多个 check 共用同一响应（`session-offers`、`releases.json` 等只取一次）。
- 代理：`fetch` 只依赖 Node 自带的 `NODE_USE_ENV_PROXY`，doctor 自己不实现代理。endpoint 探针永远直连。

## 1. 目录与文件（`flop-doctor/`，可独立分发）

```
doctor/
  package.json            name=flop-doctor, version=1.0.0, type=module, engines.node>=22,
                          bin.flop-doctor=bin/flop-doctor.mjs, scripts.test="node --test"
  README.md  LICENSE(MIT)
  bin/flop-doctor.mjs     shebang (#!/usr/bin/env node)，只调用 src/cli.mjs#main(argv, deps)
  src/
    cli.mjs               node:util parseArgs、子命令分发、退出码
    config.mjs            默认端点、阈值常量、枚举表
    budget.mjs            全局 deadline + AbortSignal
    http.mjs              fetch 封装：超时、manual redirect、体积上限、失败归类
    sources/              explorer.mjs gateway.mjs faucet.mjs releases.mjs rpc.mjs endpoint.mjs
                          每个导出 fetchX(deps) -> {ok, data, failure, ...}，并做所用字段的类型校验
    checks/               net.mjs market.mjs miner.mjs endpoint.mjs（纯函数：sources -> results[]）
    registry.mjs          check id -> {group, cause_class, reasons[], sensitiveEvidenceKeys[]}
    result.mjs            四态聚合、退出码、local 重归因
    fingerprint.mjs  redact.mjs
    util/                 ss58.mjs(base58 + blake2b512 校验和) semver.mjs planck.mjs(BigInt 十进制) netguard.mjs(IP 段分类)
    render/               text.mjs json.mjs
  schema/report.v1.schema.json   draft 2020-12，顶层与 check 层 additionalProperties:false
  test/
    fixtures/             10 类接口的真实结构快照（按场景变体）
    helpers/              mock-deps.mjs  mini-schema.mjs(子集校验器)
    *.test.mjs
```

所有 I/O 经 `deps = { fetch, resolve4, resolve6, tlsConnect, httpsGet, now }` 注入，测试只替换 `deps`。

## 2. CLI

```
flop-doctor net
flop-doctor market [--model <id|model_hash>]...
flop-doctor miner <ss58> [--endpoint https://<host>[:port]]
flop-doctor check [--miner <ss58>[=https://<host>[:port]]]... [--model ...]...
```

- **`check`**：等于 net + market + 每个 `--miner` 的 miner 组和 endpoint 组。
- **多矿工**：支持。`--miner` 可重复 1–8 次，端点用 `ss58=url` 绑定。`--endpoint` 只在恰好 1 个矿工时可用；与多个 `--miner` 同用，或与 `ss58=url` 混用，都退出 64。
- **`miner`**：只接受 1 个位置参数。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--json` | 关 | stdout 输出单个 JSON 文档（§4） |
| `--redact` | 关 | 脱敏（§4.3） |
| `--verbose` | 关 | 文本模式也列出 pass |
| `--timeout <秒>` | 20 | 全局硬预算，范围 5–120；单请求超时为 min(5s, 剩余) |
| `--min-fee-flop <十进制>` | 1 | 最多 18 位小数，BigInt 解析 |
| `--calib-warn-blocks` / `--calib-fail-blocks` | 7200 / 600 | 校准租约剩余块数阈值 |
| `--cert-warn-days` / `--cert-fail-days` | 14 / 3 | 证书剩余天数阈值 |
| `--expect-genesis <0x…64hex>` | 无 | 固定期望创世，用于识别 Devnet 重置 |
| `--network <标签>` | `devnet` | 只进入输出和 fingerprint |
| `--rpc` | `https://rpc.devnet.flop.network` | HTTP JSON-RPC |
| `--explorer` | `https://explorer.devnet.flop.network` | Explorer API |
| `--gateway` | `https://api.flop.network` | Gateway API |
| `--faucet` | `https://faucet.flop.network` | Faucet API |
| `--releases` | `https://flop.network/releases.json` | Releases manifest |
| `--help` / `--version` | | 退出 0 |

**退出码**

| 码 | 含义 |
|---|---|
| 0 | 全部 pass |
| 1 | 最差为 warn |
| 2 | 存在 fail |
| 3 | 无 fail 但存在 unknown |
| 64 | 用法错误：未知子命令或参数、ss58 校验和不合法、URL 非 https 或含 userinfo、阈值非法、warn 阈值 ≤ fail 阈值 |
| 70 | check 之外的内部异常 |

聚合优先级为 fail > unknown > warn > pass。64 和 70 的信息写 stderr；带 `--json` 时 stdout 另输出 `{schema:"flop-doctor/error/v1", exit_code, error:{kind, message}}`。

**文本输出**：首行固定，其后按 fail、unknown、warn、(pass) 再按 id、subject 排序。

```
FLOP-DOCTOR FAIL fail=1 warn=2 unknown=0 pass=21 fp=9f2c41d07a3be511
FAIL net.rpc.state_probe [upstream] http_5xx: state_getMetadata HTTP 503
WARN market.model.has_offer{qwen/qwen2.5-0.5b-instruct} [market] no_offer: 0 valid offers
```

## 3. Check 清单

### 3.0 通用规则

- **G1 源失败归类**：`timeout`、`transport`、`http_3xx`、`http_4xx`、`http_5xx`、`bad_json`、`rpc_error`、`schema`（所用字段缺失或类型不符）。具体状态码只进 evidence。
- **G2**：`*.reachable` 类 check 遇源失败判 fail。其余 check 遇源失败判 unknown，reason 为 `src_<G1>`，cause_class 为 `upstream`（`schema` 时为 `schema`）。
- **G3 本机归因**：本次请求的上游主机不少于 3 个且全部为 `timeout` 或 `transport` 时，这些结果的 cause_class 改写为 `local`。
- **G4**：预算耗尽时未完成的 check 判 unknown，cause_class 为 `budget`，reason 为 `budget_exhausted`。进程在预算 + 500ms 内必定输出并退出。
- **G5**：单个 check 抛异常时判 unknown，cause_class 为 `internal`，reason 为 `check_crashed`，不影响其他 check。
- **cause_class 枚举**：`none`（pass）、`upstream`、`market`、`operator`、`local`、`schema`、`budget`、`internal`。
- **有效 offer**：`onChainFacts.active === true && onChainFacts.blacklisted === false`（`offer.expiry` 为块高字符串，回显进 evidence）。
- **`truncated`**：`pagination.total > data.length`。v1 只取 `limit=100` 一页。
- pass 的 reason 恒为 `ok`。下表「cause」是非 pass 时的归因；除表内注明外，unknown 只来自 G2、G4、G5。

### 3.1 net（subject 为 null）

| id | 数据源和字段 | pass | warn | fail | cause |
|---|---|---|---|---|---|
| `net.explorer.reachable` | Explorer `/api/health` | 200 且 `connected===true` | 无 | 源失败；`connected!==true`（`not_connected`） | upstream |
| `net.explorer.index_lag` | `headLag` | ≤ 20 | 21–200（`lagging`） | > 200（`stalled`） | upstream |
| `net.rpc.reachable` | RPC `system_health` | 200 且有 `result` | 无 | 源失败 | upstream |
| `net.rpc.syncing` | `result.isSyncing` | `false` | `true`（`syncing`） | 无 | upstream |
| `net.rpc.finality` | `chain_getHeader()` 与 `chain_getHeader(chain_getFinalizedHead)` 的 `number` 之差 | ≤ 20 | 21–100（`finality_lag`） | > 100（`finality_stalled`） | upstream |
| `net.rpc.state_probe` | `state_getMetadata`，1 次，5s | `result` 以 `0x6d657461` 开头 | 无 | 源失败；前缀不符（`bad_metadata`） | upstream |
| `net.genesis.consistent` | RPC `chain_getBlockHash([0])`、Faucet `/chain.genesisHash`、Gateway `network.observed_genesis_hash`、Explorer `writer.genesis`，小写比较 | 4 源齐且相等 | 取到 2–3 源且相等（`partial`） | 任意两源不等（`mismatch`）；与 `--expect-genesis` 不等（`unexpected_genesis`） | upstream |
| `net.gateway.reachable` | Gateway `/health` | 200 且 `connected===true` | 无 | 源失败；`not_connected` | upstream |
| `net.gateway.syncing` | `syncing` | `false` | `true`（`syncing`） | 无 | upstream |
| `net.faucet.reachable` | Faucet `/chain` | 200 且 `genesisHash` 为字符串 | 源失败（G2 例外，降为 warn） | 无 | upstream |
| `net.releases.reachable` | `releases.json` | 200 且有 `cli.latest`、`miner-worker.latest` | 源失败（同上，降为 warn） | 无 | upstream |

`net.genesis.consistent` 取到的源少于 2 个时判 unknown（`insufficient_sources`）。

### 3.2 market

| id（subject） | 数据源和字段 | pass | warn | fail | cause |
|---|---|---|---|---|---|
| `market.models.listed`（null） | Gateway `/v1/models` | `data.length ≥ 1` | 无 | `data.length === 0`（`empty_catalog`） | market |
| `market.offers.present`（null） | `session-offers` | 有效 offer ≥ 1 | 无 | 有效 offer 为 0（`no_valid_offers`） | market |
| `market.catalog_offer_overlap`（null） | 目录的 `x-flop.model_hash` 集合与有效 offer 的 `offer.modelHash` 集合，小写比较 | 目录中每个模型都有有效 offer | 部分模型无 offer（`partial`）；交集为空但 `truncated`（`disjoint_truncated`） | 交集为空且未 `truncated`（`disjoint`） | market |
| `market.model.has_offer`（模型 `id`） | 同上，逐模型 | 该模型有效 offer ≥ 1 | 为 0 且未被 `--model` 选中（`no_offer`）；被选中但 `truncated`（`no_offer_truncated`） | 被 `--model` 选中且为 0（`no_offer`）；`--model` 不在目录中（`not_in_catalog`） | market |
| `market.model.capacity`（模型 `id`） | `x-flop.capacity_tpm`、`price_sources.length` | 两者都 > 0 | 任一为 0 且未选中（`no_capacity`） | 任一为 0 且被选中（`no_capacity`） | market |
| `market.faucet.cap`（null） | Faucet `/limits` 的 `faucet.dailyCap.remainingFlop` | > 0 | 等于 0（`cap_exhausted`） | 无 | upstream |
| `market.sponsor.slots`（null） | `sponsor.miner.automatic.{open, uncalibrated, max}` | `open===true && uncalibrated < max` | `open===false`（`closed`）；`uncalibrated ≥ max`（`full`） | 无 | upstream |

`--model` 按 `id` 或 `x-flop.model_hash` 匹配，不区分大小写。

### 3.3 miner（subject 为 ss58，每个矿工各一套）

块高 `head` 取 RPC `chain_getHeader().number`；取不到时回退 `calibration.observedAtBlock`，evidence 记 `head_source: "rpc" | "observed"`。`mine` 指 `session-offers` 中 `offer.miner === ss58` 的条目。

| id | 数据源和字段 | pass | warn | fail | cause |
|---|---|---|---|---|---|
| `miner.registered` | Explorer `/api/miners/{ss58}` | HTTP 200 | 无 | HTTP 404（`not_registered`） | operator |
| `miner.active` | `isActive` | `true` | 无 | `false`（`inactive`） | operator |
| `miner.blacklist` | `blacklisted` | `false` | 无 | `true`（`blacklisted`） | operator |
| `miner.strikes` | `strikes` | 0 | ≥ 1（`has_strikes`，fp_key 为 strikes） | 无 | operator |
| `miner.slash` | `slashHistory.length`、`totalSlashed` | 长度 0 且 `totalSlashed` 为 0 | 否则（`slashed`，fp_key 为 `slashHistory.length`） | 无 | operator |
| `miner.stake` | `selfStake + sponsoredStake`（BigInt） | > 0 | 无 | 等于 0（`no_stake`） | operator |
| `miner.worker_build` | `workerBuild.version` 对比 releases `miner-worker.{minimum, latest}`（semver） | ≥ latest | minimum ≤ v < latest（`outdated`） | v < minimum（`below_minimum`） | operator |
| `miner.calibration.state` | `calibration.{prunable, capGflopsPerSec, verifiedJobs}` | `prunable===false`、cap > 0、verifiedJobs > 0 | cap 为 0 或 verifiedJobs 为 0（`no_capacity`） | `calibration` 为空（`no_calibration`）；`prunable===true`（`prunable`） | operator |
| `miner.calibration.expiry` | `calibration.expiresAtBlock − head` | 剩余 > 7200 | 600 < 剩余 ≤ 7200（`expiring`） | 剩余 ≤ 600，含负值（`expired_or_imminent`） | operator |
| `miner.balance.fee` | Explorer `/api/accounts/{ss58}` 的 `balance`（planck，1 FLOP = 1e18）、`liveBalance` | ≥ 2×min 且 `liveBalance===true` | min ≤ 余额 < 2×min（`low`）；余额 ≥ 2×min 但 `liveBalance!==true`（`not_live`） | 余额 < min（`insufficient`） | operator |
| `miner.offer.published` | `mine` | 至少 1 条有效 | `mine` 为空且未 `truncated`（`no_offer`） | `mine` 非空但没有一条有效（`offer_invalid`） | operator |
| `miner.offer.model_known` | `mine[].offer.modelHash` 是否在 releases `models` 的键中 | 全部在 | 任一不在（`unknown_model`） | 无 | operator |
| `miner.reliability` | `mine[0].onChainFacts.reliability` | 下列计数全为 0 | `timeoutCount`、`forceOpenExpiredCount`、`ghost.expired`、`ghost.incorrect`、`disputesOpened` 任一 > 0 且未达 fail（`incidents`） | `fraudUpheld > 0`（`fraud`）；`ghost.issued ≥ 10` 且 (expired+incorrect)/issued > 0.10（`ghost_failing`）；settled+timeout ≥ 10 且 timeout 占比 > 0.20（`timeouts`） | operator |
| `miner.channels.timedout` | `work?.recentSessions ?? recentChannels ?? channels` 的 `status` | timedout 数 t 为 0，含 n 为 0 | t ≥ 1（`timedout`，fp_key 为 t） | n ≥ 4 且 t/n > 0.5（`mostly_timedout`） | operator |

表外的 unknown：
- `miner.worker_build`：`workerBuild` 为空或版本不是 semver（`no_build_info`）。
- `miner.calibration.expiry`：`calibration` 为空（`no_calibration`）。
- `miner.offer.published`：`mine` 为空且 `truncated`（`offers_truncated`）。
- `miner.reliability`：`mine` 为空（`no_offer`）。
- `miner.registered` 为 fail 时，同一矿工的其余 miner check 判 unknown（`not_registered`）。

`miner.reliability` 的 fp_key 为 `fraudUpheld:ghost.incorrect:ghost.expired:timeoutCount:forceOpenExpiredCount:disputesOpened`，计数变化即产生新告警。

### 3.4 endpoint（subject 为 `host[:port]`，仅在给出端点时运行）

全部用 `node:https` 和 `node:tls`，连接固定到 DNS check 通过的首个 IP（`servername` 为主机名），不走 fetch，不跟随重定向。

| id | 探针 | pass | warn | fail | cause |
|---|---|---|---|---|---|
| `endpoint.dns` | `resolve4` + `resolve6` | 至少 1 条记录且全部为公网地址 | 无 | 主机是 IP 字面量（`ip_literal`）；以 `.ts.net` 结尾（`tailscale_domain`，不发 DNS）；无记录（`no_records`）；任一地址在拒绝段内（`private_address`） | operator |
| `endpoint.tls` | `tls.connect`，系统信任链 | 握手可信且剩余天数 > 14 | 3 < 剩余 ≤ 14（`expiring`） | 剩余 ≤ 3（`expired_or_imminent`）；不可信或主机名不符（`untrusted`）；握手失败（`handshake_failed`） | operator |
| `endpoint.session_info` | `GET /session/info`，无 token | 状态码为 401 | 无 | 301/302/303/307/308（`redirect`）；200（`unauthenticated_access`）；其他状态码（`unexpected_status`）；连接失败（`unreachable`） | operator |

- 拒绝段：10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10、0/8、多播、文档保留段、`::1`、`fc00::/7`、`fe80::/10`，以及映射到上述段的 `::ffff:` 地址。
- `endpoint.dns` 的 unknown：解析超时或 SERVFAIL（`resolver_error`）、解析到 198.18.0.0/15（`fake_ip_suspected`，即本机代理的 fake-ip）；两者 cause_class 都是 `local`。
- `endpoint.dns` 非 pass 时，`endpoint.tls` 和 `endpoint.session_info` 判 unknown（`skipped_dns`），不发起任何连接。

## 4. JSON 输出与 fingerprint

### 4.1 结构

```json
{
  "schema": "flop-doctor/report/v1",
  "tool": { "name": "flop-doctor", "version": "1.0.0" },
  "network": "devnet",
  "command": "check",
  "generated_at": "2026-11-20T08:00:00.000Z",
  "duration_ms": 4312,
  "budget_ms": 20000,
  "redacted": false,
  "status": "fail",
  "exit_code": 2,
  "fingerprint": "9f2c41d07a3be511",
  "summary": { "pass": 21, "warn": 2, "fail": 1, "unknown": 0 },
  "checks": [
    {
      "id": "net.rpc.state_probe",
      "group": "net",
      "subject": null,
      "status": "fail",
      "cause_class": "upstream",
      "reason": "http_5xx",
      "message": "state_getMetadata HTTP 503",
      "evidence": { "http_status": 503, "elapsed_ms": 812 },
      "fingerprint": "5b0e7c1a94d2f630"
    }
  ],
  "sources": [
    { "id": "rpc.state_getMetadata", "url": "https://rpc.devnet.flop.network", "ok": false,
      "failure": "http_5xx", "http_status": 503, "elapsed_ms": 812 }
  ]
}
```

- `checks` 排序固定为 `group`、`id`、`subject`。
- `evidence` 只含判定所用字段的原值、阈值、`http_status`、`elapsed_ms`、`truncated`、`head_source`。值类型限于标量或标量数组。
- `message` 只由模板加 evidence 生成，不透传 Node 的原始错误文本（只保留 `error_code`，如 `ENOTFOUND`）。
- `reason` 是每个 check 在 `registry.mjs` 中声明的封闭枚举。

### 4.2 fingerprint

```
check.fingerprint  = sha256hex( ["flop-doctor/v1", network, id, subject ?? "", status,
                                 cause_class, reason, fp_key ?? ""].join("\n") ).slice(0, 16)
report.fingerprint = sha256hex( 非 pass 的 check.fingerprint 升序后 join("\n") ).slice(0, 16)
                     全部 pass 时 = sha256hex("flop-doctor/v1\n" + network + "\nok").slice(0, 16)
```

- 不进入 fingerprint 的内容：时间、块高、余额、延迟、具体 HTTP 状态码、message、evidence。
- `fp_key` 只在 §3 注明的 4 个 check 上使用。

### 4.3 `--redact`

- ss58 换成 `miner-N`，端点主机换成 `endpoint-N`，N 为 `--miner` 的出现顺序，从 1 起。作用范围包括 `subject`、`sources[].url`、`message`。
- `miner.*` 和 `endpoint.*` 的 evidence 中，除布尔值、阈值常量、`head_source`、`truncated` 外，全部替换为 `"[redacted]"`。
- 先脱敏再渲染，fingerprint 用别名计算。
- net 和 market 的内容是公共数据，不脱敏。

## 5. 单元测试清单（`node --test`，零网络，只替换 `deps`）

1. **基线**：全健康 fixtures，全部 pass，退出 0，输出通过 `report.v1.schema.json`。
2. **RPC 503 降级**：仅 `state_getMetadata` 503；全部 RPC 503；502 与 503 指纹一致。
3. **目录与 offer 不相交**：全不相交、`--model` 选中升级为 fail、部分相交、`truncated`、`not_in_catalog`、无效 offer 过滤。
4. **校准临期**：剩余 7201/7200/601/600/-1 边界、自定义阈值、`calibration` 为空、`prunable=true`、cap 为 0。
5. **余额不足**：`min` / `2×min` / `min-1 planck` 边界、大整数无精度损失、`--min-fee-flop 0.5`、`liveBalance=false`、非法小数退出 64。
6. **重定向与私网 IP**：301/302/307/308 单次 fail、200 fail、401 pass；全部私网/保留段 + `::ffff:10.0.0.1` + 公私混合；`*.ts.net` 不发 DNS；198.18.x unknown/local；DNS 非 pass 时不调 `tlsConnect`/`httpsGet`。
7. **TLS**：剩余 15/14/4/3 天边界、不可信链、主机名不符。
8. **脱敏**：JSON 和文本输出中无原始 ss58/主机名/IP/余额；别名与顺序一致；指纹稳定。
9. **退出码**：四态聚合矩阵（fail>unknown>warn>pass）、64（坏子命令/坏 ss58 校验和/非 https/混用 `--endpoint`/超 8 矿工）、70（渲染层异常）、单 check 异常隔离为 unknown/internal。
10. **fingerprint**：块高/延迟/同档余额变化不变；status/reason/fp_key 变化则变；顺序无关。
11. **预算**：慢源超预算判 unknown/budget，总耗时受预算约束。
12. **本机归因**：≥3 上游主机全部 `timeout`/`transport` 时改写为 `local`；单主机失败保持 `upstream`。
13. **字段漂移**：删改所用字段类型判 unknown/schema，不抛异常。
14. **多矿工**：3 个 `--miner`，`session-offers` 和 `releases` 各只请求 1 次；单矿工 404 只影响该 subject。
15. **工具函数**：ss58 校验（base58 + blake2b512）、semver 比较、planck 十进制转换、netguard IP 分类。
