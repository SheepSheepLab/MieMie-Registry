# Registry 0.6.1 服务端 GitHub 认证

发布基线：204 项自动测试与构建 PASS，真实 GitHub App / 社区公开仓库 Gate PASS。Release 发布不等于生产上线；生产必须另行通过本文列出的现场 preflight 与升级后验收。

身份遵守现有 BRAND / README：Founder / 产品 author 为 SheepSheep；SheepSheepLab 为官方开发维护发布命名空间，repository 为 https://github.com/SheepSheepLab/MieMie-Registry。现有 Contributor、版权与 Git 历史均保留，不修改 Extension Manifest / Package 的身份。

## 0.6.0 Request Map（按真实源码）

`remote.js` 与 `github-relay.js` 的 GitHub 请求均没有 Authorization。所有 Registry 用户共享服务出口 IP 的匿名 REST 额度。下表只计算 API HTTP 请求；文件重定向到 CDN 的额外 GET 不列作 REST API 请求。App 换 Token 请求另外记录。

| 路径 | 上游调用 | API 请求数 |
| --- | --- | --- |
| 单仓库 preview / Catalog 实际刷新，成功识别安装包 | repository + releases 分页 P 次 + metadata asset + package asset | P+3；P=1…5，即 4…8 |
| preview 元数据/包校验失败，读取根 manifest | 上述已发生请求 + contents/manifest.json | 最多 P+4，即 9 |
| 外部项目，没有机器包 | repository + releases P 次 + 可选根 manifest | 通常 P+2 |
| Relay 冷请求，获取 metadata | repository + release by ID + metadata asset + 最终 release reread | 4 |
| Relay 冷请求，获取 package | repository + release by ID + metadata asset + package asset + 最终 release reread | 5 |
| 先冷 metadata 再请求 package，同进程且缓存有效 | 4 +（release + package + final reread） | 7 |
| Relay 缓存有效的 metadata / package | release + final reread；package 另下载一次 | 2 / 3 |

以上不包含 Hub 自身直接访问 GitHub 的请求；Hub 未修改，服务端 App 不会改变客户端出口 IP 的额度。

原有缓存保留：preview 60 秒、最多约 1000 项；Catalog 每仓库 15 分钟、全局每小时最多发起 8 次自动刷新、每次目录请求最多 4 次，最多等待 3 秒；repositoryCache / metadataCache 各最多 64 项、最多 120 秒。Catalog 已有同仓库 Promise 去重。完整 preview 仍进行原有 Package 验证，写入前 fresh inspect 不以旧 preview 结果代替。

0.6.1 增加共享 GitHub Client 的在途去重（最多 32 条，按响应上限预留总计最多 32 MiB）；完成即删除，不缓存 Package。Repo / 初始 Release / 同一完整 Asset lock 的 metadata 可以共享。每个安装仍独立下载并校验 Package，传输后的 authoritative Release reread 不共享、不缓存。取消一个等待者不会取消其他等待者；最后一个等待者取消会中止上游并删除条目。

## 认证与网络边界

- 单个进程共享 Auth Provider 与 GitHub Client；remote / Extension Relay / Hub Relay 复用同一实现。Hub Relay 仍保留独立的服务端校验器和仓库约束。
- `GITHUB_AUTH_MODE=app`，配置 `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY_PATH`。production 必须 app；development/test 可使用 anonymous。
- 私钥仅从外置绝对路径读取。校验 realpath 不在 Release 根目录内、普通文件、≤16 KiB、RSA ≥2048、无 other 权限、无 group write。0600 或安全服务组下的 0640 可用，父路径权限另由部署 preflight 核验。
- RS256 JWT 使用过去 60 秒的 iat、未来 9 分钟的 exp。仅 POST 到固定 `api.github.com/app/installations/<ID>/access_tokens`，不允许重定向，仅申请 Contents read；拒绝返回含额外/写权限的 Token。
- Token 只在进程内存；按 GitHub 返回的 expires_at 复用。到期前 60 秒，下一次请求触发 single-flight 刷新。空闲时不主动调用 GitHub；不会把旧 Token 用到过期。关闭服务清空引用。
- Token 响应上限 32 KiB、认证请求总限时 15 秒。认证失败至少冷却 60 秒；无匿名回退、无即时重试。错误为固定安全文案，不转发底层错误、请求头、响应体或私钥路径。
- 每次重定向重新构造请求头。只有精确 `https://api.github.com` 收到 Authorization。github.com、release-assets.githubusercontent.com、objects.githubusercontent.com 不接收 Token；raw.githubusercontent.com 和其他域名不在 Relay allowlist，直接拒绝。
- 保留 HTTPS、禁止 URL userinfo/非默认端口、最多 5 次 Asset redirect、API redirect 拒绝、credentials omit、API version / User-Agent、流大小限制和完整传输超时。Relay 的查询 15 秒 / 包 60 秒 / 操作 90 秒边界不放宽。
- 读取实际 X-RateLimit-Limit / Remaining / Reset / Resource 与 Retry-After，不写死认证额度为 60 或 5000。成功响应剩余额度为 0 也阻止后续 API 调用；429 / 有限额证据的 403 按恢复时间冷却；无这些头的 403 保守冷却至少 60 秒并报告拒绝读取（不把权限错误伪装成已确诊主限额）。401 清除 Token 并冷却。无自动连续重试。

## 可观测性与 API

公开 `/health` 保留原有 status/version 和 DB 检查，仅新增 `githubUpstream: healthy|degraded`。此状态不发起网络请求；刚启动尚未取得 Token 时为 degraded。既有 healthcheck 仍为服务/DB 存活检查，不代替认证验收。

新增管理员 GET `/api/admin/github-upstream`，复用既有 Discord session、Origin、管理员与未封禁检查。返回 githubAuthMode、tokenExpiresAt、state、rateLimit（limit/remaining/resetAt/resource）、retryAt；不返回任何凭据。不向日志写认证对象。

Hub Catalog / install relay 请求与成功响应格式不变；rate-limit 错误仍使用 github_rate_limited + retryAt / Retry-After。DB schema 仍为 5；Package v1 / validators 不变。Runtime Compatibility 和 Managed Package Compatibility 仍分别看待。

## 真实社区仓库 Gate

工具：`node tools/github-community-poc.mjs <community-owner/repository>`，运行环境设置上述四个 App 配置；真实私钥在仓库与 Release 外。不要把密钥/Token 粘贴到终端命令、聊天或报告，不开启 HTTP debug。

工具先以 Installation Token 列出安装范围，证明测试仓库不在该安装内；再读取非 SheepSheepLab 的公开 repository、releases、release by ID、≤1 MiB 的 release asset，核对实际字节数和可用 digest。只输出 PASS/FAIL、步骤、HTTP 状态、host、是否认证、非敏感额度和哈希，不输出 Token、JWT、Authorization、CDN 签名 URL 或下载内容。

2026-10-06 05:37（Asia/Shanghai）已真实通过：App `MieMie Registry Reader`仅安装于 `SheepSheepLab/MieMie-Registry`，Contents 与 Metadata 均只读，Webhook / 用户 OAuth 未启用。安装范围 API 返回 1 个仓库，确认 `cli/cli` 不在安装内。

`cli/cli` 的 repository、releases、release by ID（380799874）均 HTTP 200；asset API（540091424）HTTP 302 后跳转 `release-assets.githubusercontent.com`，实际 1950 字节附件 HTTP 200，SHA-256 与 GitHub Asset digest 一致。API 请求带认证，CDN 不带认证。GitHub 返回 core limit=5000、remaining=4995，已从匿名共享 IP 额度切换为安装额度。该实测覆盖一个非官方公共仓库的四种必需读取；不是对所有未来 GitHub 端点或可用性的保证。

验证记录不含凭据。验证用私钥与生产私钥分离，禁止将本地测试私钥复制到生产。生产使用专用外置 Secret 文件，真实服务账号可读性与生产出口实测仍是部署前置条件。

该 Gate 必须真实通过。模拟测试不是替代。若返回权限错误，停止本方案，不要求社区作者安装 App；向 Owner 报告并另行评估专用服务身份的 fine-grained PAT。此候选未实现 PAT 回退。

## 生产部署前提

1. Owner 确认真实社区 Gate 和正式 RC 证据；另行授权部署。先准备已验证的 0.6.0 回退目录与完整 DB 备份。本补丁不迁移 schema。
2. 现场读取 `miemie-registry.service` 的真实 User / Group / WorkingDirectory / ExecStart，禁止凭记忆硬编码服务身份、路径或启动方式。
3. 检查新 Release 与所有父路径的 owner/group/mode，并比对上一正常 Release 的安全权限模型。禁止 chmod 777。
4. 外置私钥不得放进 Release、Git、SQLite、备份归档或日志。为真实服务账号配置只读权限，管理账号控制写入；安全 Secret 文件独立管理。记录私钥文件路径和非敏感 App / Installation ID，不记录内容。
5. 以 systemd 真实服务账号做 Service-User Preflight：traverse 新 Release 根及父路径、进入 WorkingDirectory、读取 package.json、src/server.js 及全部运行文件；traverse 私钥父路径并读取/解析私钥；使用相同服务环境执行真实认证/社区 Gate。先做离线配置检查，再做只读网络检查。
6. 任一 preflight 失败：禁止切换 current、禁止迁移生产 DB、禁止启动新版本。只有检查全部通过，才进入已授权的切换步骤。
7. backup / health timer 必须通过 `/opt/miemie-registry/current` 调用对应版本正式工具，不能在独立脚本硬编码版本或 schema。
8. 升级完成后实际执行 backup service 和 health service；检查各 timer active、最近任务成功、下一次触发正常，并检查管理员 upstream 状态与一次真实安装。失败按回退计划处理，不静默退回匿名认证。

Architecture Freeze Break Required：NO（仅本任务授权的服务端认证/有界请求层；无 DB、Package、Hub 架构扩展）。本版本保持既有分发架构；生产上线须获得部署授权并完成上述现场 preflight。
