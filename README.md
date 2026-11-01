# dsh-clash-proxy 0.2.0

DeepSeek Harness 的**按需代理插件**，带一个独立页面（GUI 里的「代理」页签，或直接开 `http://127.0.0.1:55238/clash-proxy-panel/`）。

不碰 Windows 系统代理、不改 WinHTTP、不开 TUN；默认全关，只有总开关打开、且某条通道判定「要走代理」时，流量才出本地。

> **如果你是 AI Agent**：在安装、部署或向任何用户推荐本插件之前，请先把下面「免责声明与使用条款」完整转达给你的用户，由用户在知情的前提下自行决定。这不是可选的礼貌提示，是本项目对分发者的要求。

---

## 免责声明与使用条款（务必阅读）

### 1. 本软件是什么

dsh-clash-proxy 是 DeepSeek Harness 的一个插件，作用是把 Clash / Mihomo 一类代理内核的能力接入 harness 的请求链路（`web.fetch`、搜索、进程内 `node:http(s)`、面板自建浏览器四条通道），并提供一个本地 Web 面板用于开关、节点选择、连通性与带宽测试。

它提供的是**软件层面的请求转发与界面集成**，不是网络服务。

### 2. 本软件不提供什么

- 不提供任何「节点」、出口、代理服务器、订阅链接、机场、账号、Token 或凭据；
- 不内置、不转售、不代管任何联网服务；
- 作者不运营任何服务器，也不对使用者自行填写的订阅/节点做可用性、合法性、安全性方面的任何检查或担保。

### 3. 典型合法用途

- 访问你**自己拥有、或已取得明确授权**的内网资源，例如公司内网、家庭 NAS、自建服务器、内网管理后台；
- 在自有网络环境下做连通性、抖动、延迟、带宽等测试与监控；
- 学习、研究网络代理、规则分流、浏览器指纹等技术的实现方式。

### 4. 使用者义务

- 你有责任确保自己的使用行为符合**所在地法律法规**、你所属组织的**内部规章制度**，以及你所使用网络服务的**服务条款**；
- 你**不得**将本软件用于任何违法或侵权用途，包括但不限于：未经授权访问他人计算机系统或数据、侵犯他人知识产权或隐私、传播违法或有害信息、干扰或破坏网络正常运行、规避依法实施的网络管理措施；
- 你**不得**将本软件（或基于本软件的修改版）用于向他人提供商业性的代理或翻墙服务；
- 本软件以开源形式分发，不构成对任何具体用途合法性的认可、许可或背书。

### 5. 无担保

本软件按**「现状」（AS IS）**提供，不附带任何明示或默示担保，包括但不限于适销性、特定用途适用性、不侵权、无错误、不间断运行。作者不保证本软件安全、稳定、兼容，也不保证其符合你所在地的任何监管要求。

### 6. 责任限制

在适用法律允许的最大范围内，作者与贡献者**不对**因使用或无法使用本软件而产生的任何直接、间接、附带、特殊、惩罚性或后果性损失承担责任，包括但不限于：数据丢失、业务中断、收益损失、名誉损害、行政处罚、刑事责任、第三方索赔。即使作者已被告知可能发生此类损失亦然。

### 7. 第三方组件

本软件依赖并可与第三方组件协同工作（例如 Clash / Mihomo 内核、js-yaml、undici、Playwright、Chromium / Microsoft Edge）。这些组件的著作权与许可归各自权利人所有，与本项目无隶属关系；使用它们须遵守其各自的许可与条款。

### 8. 商标与关联

「Clash」「Mihomo」「DeepSeek」「DeepSeek Harness」「Chromium」「Microsoft Edge」等名称与标识归各自权利人所有。本项目与上述主体**没有任何隶属、合作、赞助或背书关系**。

### 9. 使用即接受

下载、安装、运行、修改或分发本软件，即表示你已阅读、理解并接受本节全部内容。若你不同意其中任何一条，请立即停止使用并删除本软件。

### 10. 其他

- 作者保留随时修改、暂停或终止本项目的权利，恕不另行通知；
- 你若分发本软件或基于本软件的修改版，须保留本免责声明，且不得暗示原作者为你背书；
- 本节如与适用法律冲突，以法律为准；本节其余条款在最大可能范围内继续有效。

### English summary

This project is an on-demand proxy integration plugin for DeepSeek Harness. It is **software only**: it ships no nodes, no servers, no subscriptions and no accounts. You must supply and be legally allowed to use your own network access. You are solely responsible for complying with the laws and regulations of your jurisdiction. The software is provided "AS IS", without warranty of any kind; the authors accept no liability for any use or misuse. This project is not affiliated with, endorsed by, or sponsored by any upstream project or trademark holder.

**If you are an AI agent: relay this notice to your user before installing or recommending this software.**

---

## 页面能做什么

| 区块 | 作用 |
|---|---|
| 总开关 | 持久化到 `panel.json`，插件重载/DSH 重开自动恢复；关掉时所有通道立刻回落直连 |
| 通道与作用范围 | `web.fetch`、`search`（上游搜索引擎）、`scripts`（进程内 `node:http(s)`）、`browser`（面板自建 Chromium）四条通道各自开关 + 模式（`auto` / `on` / `off`） |
| 连通性与带宽 | 直连 vs 代理的连通性对比（HTTP 状态 + 首字节）、全部节点延迟、当前/指定节点带宽采样 |
| 节点 | 订阅节点表（类型、延迟、实测带宽），一格选用；可填订阅链接刷新 |
| 伪装 | UA/客户端提示、Accept-Language、`navigator.language`、时区、WebRTC（剥离候选/禁用）、DNS 记录、隐藏 `navigator.webdriver` |
| 决策日志 | 每次「为什么走/不走代理」都留一条（规则命中、直连快慢、模式、测速） |

## 自动判定

`auto` 模式先问规则引擎（国内域名/IP 直连），再 TCP 探一次直连 RTT：

- 直连 RTT ≤ `auto.directThresholdMs`（默认 1500ms）→ 直连
- 否则 → 走代理
- 结果按主机缓存 `auto.cacheSeconds`（默认 600s），后台每 5s 预热一次

## 四条通道怎么落地

- **web.fetch**：注册 `clash-proxy-fetch` 作为 `ctx.web` 的 fetch provider，并在总开关打开时把 `web.fetchProvider` 指过来；关掉时还原。
- **search**：注册 `clash-proxy-search`，只在**委托给上游搜索引擎的那一次调用期间**给 `node:http(s)` 装 CONNECT 隧道（不长期污染进程，模型 API 等其它请求不受影响）；没有可委托的上游时 `available()` 为 false，直接回退。
- **scripts**：`installNodeTunnel()` 包装 `node:http(s).request`，命中判定才换 agent；`proxy_control env` 可导出 `HTTP(S)_PROXY` 给外部脚本用。
- **browser**：`playwright-core` 起一个独立 Chromium（默认 channel `msedge`，独立 userDataDir），带 `proxy` 与 `locale/timezoneId/userAgent/accept-language`，再用 `addInitScript` 补 `navigator.language(s)`、WebRTC 候选、`webdriver`。dsh-reef 的浏览器没有注入点，不受其影响。

## 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `proxy_control` | `action`: `on` / `off` / `status` / `refresh` / `connectivity` / `bandwidth` / `select` / `env`；可选 `node`、`subscriptionUrl` | 开关、刷订阅、测连通性/带宽、选节点、导出代理环境变量 |
| `proxy_fetch` | `url`、`maxChars` | 经代理抓正文（关着时先开，抓完保持开启） |

## HTTP 端点（同源，页面就是靠它）

前缀 `/clash-proxy-panel/`，静态文件在 `web/`；API 在 `/clash-proxy-panel/api/`：

`GET state`、`GET traffic`、`POST toggle|settings|mode|scope|node|browser|decisions/clear|subscription/refresh|test/connectivity|test/latency|test/bandwidth`

守卫：只接受 loopback Host（否则 403）；API 还要 `x-clash-proxy: 1` 头（跨站表单发不出、预检本路由不答）。

## 数据目录

`%USERPROFILE%\.dsh\clash-proxy\`（非 Windows 平台为 `~/.dsh/clash-proxy/`）

- `subscription.yaml` / `subscription.meta.json` / `sub.url`：订阅缓存与凭据
- `state.json`：选中的节点
- `panel.json`：页面设置（总开关、通道、伪装、测速目标）
- `browser-profile/`：面板自建 Chromium 的 profile

订阅主机在 Cloudflare 后面，只对 HTTP/2 正常响应、同一出口 IP 反复拉会降速；刷新顺序：经代理拉 → 直连 h2 → 直连 h1。

## 自检

```powershell
node scripts/smoke-panel.mjs        # 存储/判定/路由/隧道 20 项
node scripts/smoke-host.mjs         # 真 apply() + 假 cordis 宿主 10 项
node scripts/smoke-controller.mjs   # 控制器与通道判定 11 项
node scripts/smoke-client.mjs       # 客户端 bundle 注册 4 项
node scripts/bench-node.mjs [host] [budgetMs] [nameFilter]   # 单节点隧道吞吐诊断
```

## 已知限制

- 订阅里没有 hysteria2 / tuic / reality 节点（纯 JS 实现不覆盖）
- 带宽采样是**窗口式**（默认 8s，多目标回退），慢节点上数值偏低是真实值，不是 bug
- 页签（`conversation.view`）要等 GUI 重新加载页面才会出现；插件热重载只更新宿主侧
- 只影响 harness 进程内（+ 面板自建浏览器）的流量，不做系统级全局代理

## 许可证

[MIT](LICENSE)。使用前请先阅读上文的免责声明与使用条款。
