# 审计与修复记录（0.2.0 → 0.3.0）

本文件是 2026-11 那次改进任务的问题清单与处理结果。约定：

- **P0**：安全漏洞、数据损坏、进程崩溃；必须修。
- **P1**：功能错误（本来该工作却错/静默失效）；必须修。
- **P2**：健壮性、资源泄漏、兼容性；计划修。
- **P3**：文档、体验；随手修。

状态只有三种：**已修复**（有测试证据）、**待验证**（无法在本机确认，只记录）、**已知限制**（明确不改，写进 README）。

---

## 一、已修复

### 网络安全与拦截（`lib/core/tunnel.js`）

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| P1 | `tunnel.js` `planCall()` | `http.request(new URL(...))` 直接返回未改动参数，URL 实例调用**完全绕过代理** | `planCall` 支持字符串 / `URL` 实例 / options / `request(url, options, cb)` 合并 |
| P1 | `tunnel.js` `wrap()` | `next.agent = httpsAgent` 无条件覆盖调用方显式传入的 `agent`，自定义 Agent 与 TLS 配置被丢弃 | 调用方给了 `agent` 就一律不动；只在自己决定代理时替换 |
| P0 | `tunnel.js` `dispose()` | 直接把 `http.request` 还原成启动时的函数，会覆盖别的插件**之后**安装的包装器 | 全局注册表（`Symbol.for("dsh-clash-proxy.tunnel-registry")`）+ refs 计数；仅当 `http.request === state.wrappers.http` 时才还原，否则只把本包装器置 `active=false` 变直通 |
| P0 | `tunnel.js` `installNodeTunnel()` | 无重复安装保护，二次安装会叠加多层包装 | 注册表里已有则只加 refs，返回同一 dispose 句柄 |
| P1 | `tunnel.js` `connectTunnel()` | 响应头无上限、不检查非 2xx 之外的异常形态、握手无超时、错误时监听器不清理 | `MAX_HEADER_BYTES=16KiB`、非 2xx 报错、`CONNECT_TIMEOUT_MS=20s`、统一 `cleanup()`、提前 close 报错 |
| P1 | `tunnel.js` `connectTunnel()` | 成功分支没处理「200 头同一包里还带了服务器数据」 | `socket.unshift(rest)`，且 `pause()` 后再交给消费者，`setImmediate` 恢复读取（否则 http 客户端读不到响应） |
| P1 | `tunnel.js` `HttpsTunnelAgent` | 隧道内 TLS 握手无超时；`ca/cert/key/pfx/minVersion/checkServerIdentity` 等全部不透传 | `TLS_TIMEOUT_MS=15s`；白名单 `TLS_OPTION_KEYS` 透传调用方 TLS 选项（不替调用方放宽校验） |
| P2 | `tunnel.js` agent 缓存 | 端口变化时直接 `destroy()` 旧 Agent，会杀掉正在跑的请求 | `Map<port, agent>`，超过 8 个条目只删引用不 destroy（keepAlive 关闭） |
| P2 | `tunnel.js` loopback | 本机请求也进隧道 | `isLoopbackHost()`（127/8、::1、localhost、`::ffff:127.x`）直接直连 |

事故记录：重写 `connectTunnel` 时先写成「成功后 `socket.pause()` 直接返回」，导致经隧道发出的 HTTP 请求全部挂死；由 `tests/tunnel.test.mjs` 的 options/URL 通过隧道取回响应用例抓出，改为 `callback` 之后再 `setImmediate(resume)`。

### HTTP/SOCKS5 入站（`lib/core/proxy-server.js`）

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| P0 | `#readHttpHead` | `Buffer.concat` 无上限，客户端发无限请求头可耗光宿主内存 | `MAX_HEAD_BYTES=32KiB`，超限断开 |
| P0 | `#handleSocks5` / `#readSocks5Request` | `client.once("data")` 假定握手整包到达，分片即协议错乱 | 按字段累积读取（greeting、atyp 1/3/4 分别等 10 / 5+len+2 / 22 字节） |
| P1 | `#handleAbsolute` | `https://` 绝对形式被当明文写到 443 端口 | 改回 `501 Not Implemented` 并提示用 CONNECT |
| P1 | `#handleAbsolute` | 请求体永远不转发（只做了 face→client 单向） | 改写头写完后走 `#relay()`，双向转发；新增回归测试 `absolute-form request bodies are forwarded, not dropped` |
| P1 | `#handleAbsolute` | 绝对形式端口写死 80 | `defaultPortFor(protocol)`（http 80 / https 443） |
| P2 | `stop()` | 注释说销毁在途连接，实际只 `server.close()` | `#sockets` 集合，`stop()` 逐个 `destroy()` |
| P2 | `parseConnectTarget` | `[::1]:443` / 垃圾输入处理不一致 | 显式解析，非法返回 `null` → 400 |
| P2 | `start()` | `once("error")` 只在 listen 前有效，listen 成功后服务器级错误被吞 | listen 回调里换成一个常驻 error 监听（DEBUG 时打印） |
| **P1** | `#handle` / `#readHttpHead` / `#relay` | 请求头之后、同一 TCP 段里到达的字节（管线化 CONNECT 的 payload、absolute-form 的 body）被静默丢弃：`client.unshift(rest)` 时 socket 仍处 flowing 模式且暂无监听器 | dispatch 前 `client.pause()`；`readMore()` cleanup `socket.pause()`、挂好监听后再 `resume()`；`#relay()` 末尾 `client.resume()`。回归测试「CONNECT keeps payload that arrives in the same segment」 |
| **P1** | `#connect(host, port)` | 目标为 loopback 时不特判，`engine.decide("localhost")` 默认 `proxy` → 代理把「连本机」的请求转发到远端节点去连它自己的 loopback（错误目标 + 意图泄漏） | `isLoopbackHost(host)` 命中即 `direct`；回归测试「a loopback target stays direct even when the default policy says proxy」（断言上游节点一次 CONNECT 都没收到） |

### 传输层（`lib/core/transports.js`）

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| P1 | `encodeAddr()` | IPv6 用 `host.split(":")` + `parseInt`，压缩地址（`2001:db8::1`）编码出错误的字节 | 新增 `ipv6Bytes()` 正确展开（含 `::`、方括号、尾部 IPv4），`encodeAddr` 复用 |
| P1 | `measureLatency()` | `Promise.race` 超时后，迟到返回的 face 永远不关闭 → 每次慢节点测速泄漏一个 socket | 超时标志 + `face.close()`，`finally clearTimeout` |
| P2 | `tcpConnect` / `tlsConnect` | 没有连接超时，只有外层 race | `CONNECT_TIMEOUT_MS=15s`，连接成功后清零；`connectThrough(node, host, port, { timeoutMs })` 可注入 |
| P2 | `SocketBuffer` | 无背压：消费慢时 socket 持续读、内存无上限 | `HIGH_WATER=1MiB` / `LOW_WATER=64KiB` + `#throttle()`；`read`/`readAny` 先查错误 |
| **P1** | `httpConnect` / `socks5Connect` 等的握手 | TCP 连上后等节点回 CONNECT/hello **没有超时**：节点 accept 但不回话就永久挂住（实测向 `www.gstatic.com:80` CONNECT 挂 >120 秒） | 新增 `armHandshake(socket, timeoutMs)`（`socket.setTimeout` + `destroy`），6 个 connect 函数在拿到 socket 后各武装一次；`rawFace()` 里 `setTimeout(0)` 结束握手期；`connectThrough()` 外层再加 `timeoutMs + 1000` 兜底（迟到 face 关闭，不泄漏） |
| **P2** | `tcpConnect` / `tlsConnect` | 用 `socket.setTimeout(timeoutMs, cb)` 做连接超时，成功后只 `setTimeout(0)`：Node 不会移除已注册的 'timeout' 监听器，之后任何空闲超时都会用「tcp connect timeout」杀掉已连上的活 socket | 改为显式 `setTimeout()` + 成功后 `clearTimeout` + `removeListener("error", onError)` |

事故记录：本次用 PowerShell 多行字符串替换改 `transports.js`，`foreach` 里嵌套数组被展平、`a`→`s` 全局替换，文件被改坏（`export clsss SocketBuffer`）。处理：从 npm 安装副本重建原始 0.2.0 文件，再用 26 个锚点断言的 Node 脚本重打补丁。**教训：多行/精确文本替换一律用 Node 脚本 + 锚点断言，不用 PowerShell 字符串。**

### 规则引擎（`lib/core/rules.js`）

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| P0 | `inCnCidr6()` | 逻辑写错：只有与网段起始地址**完全相同**才比较前缀，IPv6 国内地址实际几乎全部判成境外 | 重写为 16 位一组的前缀比较 + 有序扫描（下一条 network 已大于候选即返回 false） |
| P1 | `ipv4ToInt()` | `"1.2.3."`、`"01.2.3.4"` 被接受 | 严格四段、1–3 位、无前导零、0–255 |
| P1 | `ipv6ToGroups()` | 不支持 `::ffff:1.2.3.4`；不校验组长度与组数；`%zone` 未拒绝 | 重写，支持压缩写法与尾部 IPv4，拒绝 `:::`、`%eth0`、>8 组、>4 位十六进制 |
| P1 | `compileRule()` | `IP-CIDR` 前缀 33+ / 负数照样生成掩码；非法规则被静默丢弃 | 校验 0–32 / 0–128 且必须有 `/`；返回 `{ error }` 进 `RuleEngine.diagnostics`（上限 100，用户规则全量、订阅规则只记受支持类型） |
| P1 | `decide()` | `baidu.com.`（尾点 FQDN）、IDN、大写、方括号 IPv6 判定不一致 | `normalizeHost()`：小写、去方括号、去尾点、IDN→punycode |
| P1 | `decide()` | IPv4-mapped IPv6 不查 IPv4 表 | 额外用映射出的 IPv4 再查一次 |
| P2 | `GEOIP,CN` | 未支持，订阅里常见的规则被静默忽略 | 支持 `GEOIP,CN`（同时查 IPv4/IPv6 两张 CN 表） |
| P2 | CN 表加载 | 加载时不排序、重复项未去重 | 加载时过滤非法项 + 排序去重 |
| P2 | 诊断不可见 | 非法规则只进内存，面板与工具都看不到 | `manager.rulesDiagnostics()` → `controller.state().rulesDiagnostics` → 面板「⚠ N 条规则无法解析」+ 悬停明细 |

证据：`tests/rules.test.mjs` 13 项；CN 表抽样 `1.0.1.5` 命中、`9.9.9.9` 不命中、`2001:250::1` 命中、`2001:db8::1` 不命中、`2c0f:f7a8:9020::1` 命中。

### 面板安全（`lib/panel/routes.js`）

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| P0 | API 守卫 | 只检查 `x-clash-proxy` 头是否存在——任意本地进程/页面都能调用写接口 | 每实例 `randomBytes(32)` 令牌；注入到 HTML `<meta name="clash-proxy-token">`；API 要求 `x-clash-proxy-token`，`timingSafeEqual` 比较 |
| P0 | API 守卫 | 无来源检查，跨站请求只要带上常量头就能打 | `Sec-Fetch-Site`（仅 same-origin/none）与 `Origin`（host 必须等于 Host 头）；`OPTIONS` 一律 405，永不回答预检 |
| P1 | 错误响应 | 500 直接把 `error.message` 回给页面（可能带路径/URL） | 只回 `{ ok:false, error:"internal error", ref }`；真实原因脱敏后写本地 console；校验类错误（`PanelInputError`）才回显 400 |
| P1 | `serveStatic` | `normalize(join())` + startsWith 只挡了字符串穿越，符号链接可逃逸 | `fs.realpath` 校验真实路径仍在 `web/`；`decodeURIComponent` 失败/`\0` 直接 404 |
| P2 | `readBody` | 超限时 `req.destroy()`，客户端看到的是连接重置而不是错误 | 立即 400，剩余字节 drain 掉（`req.resume()`） |
| P2 | 静态响应 | 无 `nosniff`、无 `frame-ancestors` | 加 `x-content-type-options: nosniff`、`content-security-policy: frame-ancestors 'self'`、`cache-control: no-store` |

证据：`tests/panel.test.mjs` 14 项 + `scripts/smoke-panel.mjs` 25 项（含跨站、错 token、旧头、并发 patch、配置损坏隔离、编码穿越）。

### 配置与文件写入

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| P0 | `manager.js#loadSubscription`、`controller.js#refreshSubscription`、`manager.js#saveState` | 直接 `writeFile`，写到一半崩溃/断电会留下半截 YAML/JSON | 新增 `lib/core/fs-atomic.js`：临时文件 → `fsync` → `rename`；全部写入改走它 |
| P0 | `subscription.meta.json` | 明文保存完整订阅 URL（本身是 bearer 凭据） | 只存 `{ at }`，不再落盘 URL |
| P1 | `PanelStore.load()` | 配置损坏时静默回默认值，用户设置无声消失 | 损坏文件改名 `*.corrupt-<ts>` 保留现场 + console.error，再回默认值 |
| P1 | `PanelStore.patch()` | 并发 `patch` 会互相覆盖（读-改-写竞争） | `#queue` 串行化；并发 10 次 patch 的读回一致性已有测试 |

### 节点选择（`lib/core/manager.js`）

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| P1 | `isSupported()` | `hysteria2` 在支持列表里，但本发行版没有 `lib/native/connector.exe`，auto/url-test 可能选到必然失败的节点 | `hysteria2`、`vless+reality` 仅在 `hasNativeConnector()` 为真时算支持 |

---

## 二、保留未改（含理由）

- **`lib/core/inject.js` 全文件未使用**：它会给 `process.env` 写代理变量并替换全局 dispatcher，本 fork 明确不用（`manager.js` 顶部注释说明）。删掉是「减少死代码」，但它是原作者的能力备份，且删除不影响运行——按「不重写正常模块」，本次**不动**。
- **`manager.handleHttp()`**：遗留的 `/clash-proxy/*` 端点集合，**本仓库内无任何调用方**（已 grep 全仓确认），当前不可达。它没有 loopback/token 校验，属于潜在攻击面；因为无法确认是否有外部调用方，按任务书「无法确认的问题标记待验证」，本次**不删不改**，留待 0.4.0 决定（删除或加同样的守卫）。
- **`#relay()` 无显式背压**：`face.write()` 的返回值被忽略，慢上游 + 大上传时 Node 内部写缓冲会增长。face 抽象没有 `drain` 信号，加背压要动 6 个 transport 的接口，超出本次「不重写」范围 → 记为已知限制。
- **国内 IP/域名数据文件**：`lib/core/data/*.json.gz` 是构建时快照（`cn-cidrs` 7456 条，`cn-cidrs6`、`cn-domains` 约 11 万条后缀）。数据陈旧与更新机制属于独立功能，需要数据源设计，本次只加了加载期校验/排序，**未做在线更新**。

---

## 三、待验证

1. **DNS rebinding**：当前靠 Host 头 + token 双保险；`Host: 127.0.0.1:<port>` 才放行，DNS 重绑定需要受害者浏览器把域名解析到 127.0.0.1 且 Host 头仍是攻击者域名 → 被 Host 检查拒绝。已用 `tests/panel.test.mjs` 的 `non-loopback Host headers are refused` 覆盖可复现路径，但没有在真实浏览器里跑过 rebinding 场景。
2. **Windows 符号链接穿越**：`resolveStatic` 用 `realpath` 挡住 symlink 逃逸，但测试环境创建 symlink 需要权限，`tests/panel.test.mjs` 未覆盖「web/ 里放一个指向仓库外的链接」这一具体用例；逻辑上 `realpath` 后仍做前缀校验，属于代码级防护，缺实测。
3. ~~**Node 20/22 上的行为**~~ → **已实测**：Node 20.19.0、22.20.0（nodejs 官方单文件 exe）各跑 `tests/run.mjs`，均 70/70、exit 0。唯一与版本相关的差异是 TLS 失败文案（Node 22 报 `SSL routines:tls_get_more_records:packet length too long`），`tests/tunnel.test.mjs` 的正则已覆盖两种文案。
4. **`lib/native/connector.exe`**：本仓库没有该二进制，hysteria2 / VLESS REALITY 在本发行版不可用。若未来打包，需要重新评估 `isSupported` 与 README 协议表。
5. **IPv6 目标**：本机没有 IPv6 出口，`net-matrix.mjs` 的 IPv6 用例只能记为环境跳过。已用 `net-direct.mjs` 覆盖「IPv6 字面量 CONNECT 目标」（`[::1]` 到本地 echo 服务，17/17 里含此项），但那验证的是地址解析与本地转发，不是真实 IPv6 出网路径。

---

## 四、测试与证据

| 套件 | 数量 | 命令 | 结果 |
|---|---|---|---|
| 规则引擎 | 13 | `node tests/rules.test.mjs` | 通过 |
| CONNECT 隧道 / http(s).request 包装 | 12 | `node tests/tunnel.test.mjs` | 通过 |
| 传输层 / SocketBuffer / 延迟测量 / 上游握手超时 | 13 | `node tests/transports.test.mjs` | 通过 |
| HTTP+SOCKS5 入站 | 17 | `node tests/proxy-server.test.mjs` | 通过 |
| 面板路由安全 | 14 | `node tests/panel.test.mjs` | 通过 |
| 合计 | **70** | `npm test` | 全部通过（Node 20.19.0 / 22.20.0 / 24.22.1 各 70/70，exit 0） |
| 面板冒烟 | 25 | `npm run smoke`（第一段） | 通过 |
| 宿主冒烟 | 10 | 同上 | 通过 |
| 控制器冒烟 | 12 | 同上 | 通过 |
| 客户端 bundle 冒烟 | 4 | 同上 | 通过 |
| 真实网络冒烟 | — | `npm run smoke:net` | 手动执行，见测试报告 |

未在 CI 里跑 `scripts/smoke.mjs`：它需要公网与真实订阅，CI 环境没有，**不伪造通过**；CI 只跑离线的单元/集成与四段冒烟。

---

## 五、真实环境实测（2026-11-06，本机）

环境：Windows 11（ASUS）、Node 24.22.1；另下载 Node 20.19.0 / 22.20.0 官方单文件 exe 各跑一遍；真实订阅 22 个 `vless` 节点；**本机无 IPv6 出口**，直连国外站点被墙（`http://example.com` 与 `https://www.baidu.com` 直连可用）。

### 1. 单元/集成

`node tests/run.mjs`：Node 24.22.1 / 20.19.0 / 22.20.0 各 **70/70，exit 0**。

### 2. DIRECT 模式网络矩阵（插件自身管线，17 项，全通过）

`net-direct.mjs`，`extraRules: ["MATCH,DIRECT"]`，本地夹具 + `example.com`/`baidu.com`：

| 用例 | 结果 |
|---|---|
| absolute-form GET（example.com） | 200 |
| absolute-form POST body 到达源站（本地 echo） | body 完整 |
| CONNECT + 同段管线化 payload | 同包 payload 不丢 |
| HTTPS via CONNECT（baidu.com，真实 TLS） | 200 |
| 自签名证书被拒绝 | SKIPPED/ENV（本机 PATH 无 openssl） |
| 50 并发 CONNECT 隧道 | 50/50 |
| 15 秒滴流长连接 | 15B，>12s |
| 8MB 处中断下载 | 隧道随取消拆掉 |
| 20MB 完整下载 | 字节数与 SHA-256 均一致 |
| DNS 失败 | 代理回 502 |
| IPv6 字面量 CONNECT（`[::1]` 本地 echo） | 通过（仅地址解析/本地转发） |
| stop() 时在途请求 | 不挂起，返回错误 |
| 停机后新端口重启并服务 | 200 |
| 停机后代理端口无 ESTABLISHED 残留 | 0 |

### 3. 订阅节点模式网络矩阵（10/17，失败项逐条归因）

`net-matrix.mjs --mode=subscription`：通过项包括「找到可用节点」「HTTPS via CONNECT（`api.ipify.org` 200）」「self-signed 被拒」「loopback CONNECT 本地服务」「50 并发 HTTPS 50/50」「in-flight 于 stop() 不挂」「stop 后新端口重启」「无 ESTABLISHED 残留」「干净停机」。

失败 7 项及证据（**均非插件缺陷**，写在这里避免被当成"测试通过"）：

- `absolute-form GET`（400/空）：同一节点 `GET http://www.gstatic.com/generate_204` 返回 **204**，说明绝对形式与节点转发正常；`example.com:80` 经该节点无响应/被上游拦截。
- `absolute-form POST body`（402）、`15s drip`（402）：`httpbingo.org` 在链路上被拦（手机/ISP 侧 402 页面），直连模式用本地 echo 已覆盖 body 转发。
- `DNS failure`：节点侧 DNS 被污染，报 TLS alert 而不是 502；DIRECT 模式下该用例已通过（502）。
- `8MB 中断`、`20MB 下载`：`speed.cloudflare.com:443` 经节点连接超时（节点到 Cloudflare 不通），非下载逻辑问题；DIRECT 模式 20MB 已字节级校验。
- `IPv6 target`：本机无 IPv6 出口，环境跳过。

### 4. 面板安全与 UI

- `panel-probes.mjs`（真实 `lib/panel/routes.js` + `web/` + stub controller）**18/18**：令牌注入、`nosniff`/`frame-ancestors 'self'`、无/错/旧头 403、`Host: localtest.me`（真实解析到 127.0.0.1 的 rebinding 式域名）403、`Origin`/`Sec-Fetch-Site` 跨站 403、`OPTIONS` 405 且无 ACAO、三种编码穿越 404、`mklink /J` 指向 `C:\Windows` 后越权请求 404（`realpath` 生效）、坏 JSON/600KiB body 400、同源 POST 200。
- 真实浏览器（Edge/CDP）打开面板：标题、开关（「代理已开启」+「运行中 · :端口」）、模式下拉、节点「选用」、伪装设置保存 toast、「⚠ N 条规则无法解析」提示均正常。截图 `D:\deepseek harness\clash-test\shots\panel-enabled.png`。
