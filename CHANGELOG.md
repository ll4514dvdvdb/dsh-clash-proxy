# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.1] — 2026-11-08

只动测试编排与发布产物，插件行为与 0.3.0 相同。

### Fixed

- CI 在 Node 20 / 22 / 24 上全红：`npm run smoke` 串了 `smoke-host.mjs`，而它 `import lib/index.js` → `@deepseek-ai/dsh-tools`。这些包是本插件的**可选 peer**（插件不自带运行时），干净环境里装不到，于是整个 smoke 步骤以 `ERR_MODULE_NOT_FOUND` 失败。
- `npm run smoke` 现在只跑不需要宿主的三组（面板 25 + 控制器 12 + 客户端 bundle 4）；`npm run smoke:host` 单独跑宿主 10 项，`npm run smoke:all` 两者都跑。README 与 `ci.yml` 注释写明这是**文档化的缺口，不是通过**。

### Added

- `docs/screenshots/panel.png` 与 `screenshots.json`（市场卡片截图）、`docs/icon.png`（市场图标）。
- GitHub Release 附预构建 `dsh-clash-proxy.tgz`（资产名不带版本号，`releases/latest/download/` 才能解析）。

## [0.3.0] — 2026-11-06

安全与正确性修复版本。没有新增用户可见功能，默认分流策略未改动。

### Security

- 面板 API 改为**每实例随机令牌**认证：令牌注入到页面 `<meta name="clash-proxy-token">`，调用方必须带 `x-clash-proxy-token`；旧的 `x-clash-proxy: 1` 常量头只说明「是个本地面板请求」，不再作为认证。
- API 增加来源校验：`Sec-Fetch-Site` 仅允许 `same-origin` / `none`；`Origin` 的 host 必须等于 `Host` 头；`OPTIONS` 预检一律 405。
- 500 响应不再回显 `error.message`，只返回 `{ ok:false, error:"internal error", ref }`；真实原因脱敏（URL、盘符路径→`<url>`/`<path>`）后写本地日志。
- 静态文件改用 `fs.realpath` 校验，阻止符号链接逃逸；响应补 `nosniff`、`frame-ancestors 'self'`、`no-store`。
- `node:http(s).request` 包装器的 `dispose()` 不再无条件还原原始函数：仅当当前函数仍是本插件安装的那个才还原，否则把自己的包装器置为直通，**不会覆盖其他插件之后安装的包装器**。
- 订阅 URL（bearer 凭据）不再写入 `subscription.meta.json`。

### Fixed

- `http.request(new URL(...))`（URL 实例调用）此前完全绕过代理。
- 调用方显式传入的 `agent` 不再被覆盖，自定义 Agent 与 TLS 配置得以保留；隧道内 TLS 握手透传 `ca/cert/key/pfx/minVersion/checkServerIdentity` 等选项。
- CONNECT 握手：限制响应头上限、校验非 2xx、握手超时、提前关闭报错、监听器统一清理、200 响应同包的额外数据用 `unshift` 保留。
- 经隧道发出的 HTTP 请求不再挂死（成功分支先 `pause()`，交还 socket 后 `setImmediate` 恢复读取）。
- 代理端口切换不再 `destroy()` 旧 Agent，正在运行的请求不会被腰斩。
- HTTP 入站请求头加 32 KiB 上限，防止恶意客户端耗光内存。
- SOCKS5 握手支持 TCP 分片（greeting 与 atyp 1/3/4 分别按字段长度累积）。
- 绝对形式 `https://` 请求改为 `501`（此前会把明文写到 443 端口）。
- 绝对形式请求的**请求体**现在会转发（此前只回传响应，POST/PUT 的 body 静默丢失）。
- 绝对形式端口按协议取默认值（http 80 / https 443），不再一律 80。
- `ProxyServer.stop()` 会销毁在途连接；listen 成功后的服务器级错误不再被吞。
- 入站 `#handle()` 在分发前暂停 socket、`#readMore()` 挂好监听后再恢复：请求头之后同一 TCP 段里到达的字节（管线化 CONNECT 的 payload、absolute-form 的 body）不再被丢弃。
- 代理对 **loopback 目标**强制直连（此前 `localhost` 默认走节点，会让远端节点去连它自己的 127.0.0.1）。
- 上游节点握手（CONNECT / SOCKS5 hello 等）加了超时：节点接受 TCP 却不回话时不再永久挂住，超时报错且不泄漏 socket。
- `tcpConnect` / `tlsConnect` 的连接超时改用显式定时器：连接成功后 `clearTimeout`，不会再被后续空闲超时误杀。
- IPv6 目标地址编码修正（压缩写法、`::ffff:1.2.3.4`、方括号）。
- 节点测速超时后不再泄漏 socket（迟到 face 会被关闭）；TCP/TLS 建连有 15 s 超时。
- `SocketBuffer` 增加高低水位背压，慢消费者不会让内存无上限增长。
- 规则引擎：IPv6 CIDR 匹配重写（原实现只有与网段首地址完全一致才命中）；`IP-CIDR/IP-CIDR6` 前缀越界校验；`1.2.3.` / `01.2.3.4` 不再被接受；支持 `GEOIP,CN`、尾点 FQDN、IDN、IPv4-mapped IPv6；非法规则进入 `RuleEngine.diagnostics` 而不是被静默丢弃。
- 配置与订阅缓存改为原子写（临时文件 → `fsync` → `rename`）；`panel.json` 损坏时自动改名隔离为 `*.corrupt-<ts>` 并回默认值；并发 `patch()` 串行化。
- `hysteria2` / `vless+reality` 只有在 `lib/native/connector.exe` 存在时才算「可用节点」，避免自动选择选中必然失败的节点。

### Added

- `lib/core/fs-atomic.js`：原子写工具（0600 权限）。
- `tests/`：67 个离线测试（规则 13、隧道 12、传输 12、入站 16、面板 14）。
- `npm test` / `npm run smoke` / `npm run smoke:net` 脚本。
- `.github/workflows/ci.yml`：Node 20/22/24 矩阵，语法检查 + 离线测试 + 四段冒烟 + 依赖审计 + 打包内容检查。
- `docs/AUDIT.md`：问题清单、风险等级、代码位置与修复证据。
- 面板令牌机制与安全模型说明（README）。

### Changed

- 版本号统一为 0.3.0（`package.json`、`controller.js` 的 `VERSION`、README、冒烟断言）。
- `web/app.js` 与 `scripts/smoke-*.mjs` 跟随新认证契约（`x-clash-proxy-token`）。

### Known limitations（未在本次修复）

- `#relay()` 没有显式背压（face 抽象无 `drain` 信号）；大流量上传到慢上游时依赖 Node 内部写缓冲。
- `manager.handleHttp()` 是仓库内无调用方的遗留端点集合，未删除也未加守卫（见 AUDIT「保留未改」）。
- 国内 IP/域名数据仍是构建时快照，没有在线增量更新。
- 无 `lib/native/connector.exe`：hysteria2 / VLESS REALITY 不可用。
- 带宽采样仍是窗口式估算，不代表峰值。

## [0.2.0]

- 合并为单插件单页面（此前分多个包），新增 `web.searchProvider` 委托通道、面板自建浏览器、伪装选项、决策日志、节点延迟/带宽测试。
- 面板 API 增加 `x-clash-proxy` 常量头作为最低限度的跨站防护。

## [0.1.x]

- 初始版本：进程内 `node:http(s)` 隧道、`web.fetch` 按需代理、订阅解析、基础规则引擎与本地面板。
