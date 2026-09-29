# Registry API v1

地址以部署的 `PUBLIC_BASE_URL` 为准。除头像与 Package 字节接口外，响应为 JSON；错误格式：

```json
{"error":{"code":"unauthorized","message":"请使用 Discord 登录"}}
```

所有写操作必须携带已允许的 `Origin` 和 `Content-Type: application/json`。认证 API 使用 `Authorization: Bearer <opaque Registry session token>`，并绑定创建会话时的 Origin。浏览器自动设置 Origin。没有 Cookie 认证回退；客户端不得把会话 Token 放入 URL、localStorage、日志或 Catalog。

## Public

- `GET /api/catalog?page=1&pageSize=20&source=github&q=关键词` → `{items,page,pageSize,total,hasMore}`。pageSize 为 1–50；source 可省略或为 github/discord。未认证只返回 public；携带有效 Registry Bearer 时在服务端验证当前 Guild 成员身份。过滤发生在分页、搜索及 total/hasMore 计算之前，任何查询参数都不能授予权限。
- `GET /api/catalog/:id` → 单条当前用户可见项目；下架、隐藏、无成员权限及未知 ID 均返回 404。
- `GET /api/avatars/:opaqueKey` → 受限 PNG；key 为随机不透明标识。
- `GET /health` → `{status,version}`。
- `POST /api/packages/github/asset` → 经验证的原始文件字节，`application/octet-stream`、准确 `Content-Length`、`Cache-Control: no-store`。无需 Discord 登录、Bearer Token 或 GitHub Token；必须携带配置允许的 Origin。

### 作者 GitHub 字节传输

请求 JSON **只能**包含以下三个字段（Development Fixture）：

```json
{"repository":"https://github.com/Example/Fixture","releaseId":20,"assetId":30}
```

`repository` 必须是 GitHub API 返回的规范大小写的公开仓库地址，没有 `.git`、末尾斜线、查询参数或用户凭据。两个 ID 必须为正安全整数。接口不接受任何下载 URL 或额外字段。

服务端从该仓库官方 API 获取指定 Release，验证其非 Draft、纯三段版本、唯一 `MieMie-Extension-update.json`、GitHub size/digest、Manifest 的仓库／身份／API／版本，以及声明的唯一 Package Asset。只能请求此元数据 Asset 或此安装包 Asset。直接仓库预览不要求已有 Catalog 投稿，但必须通过相同 Manifest 验证；普通外部项目不能利用此接口转发任意文件。

Package 返回前校验完整文件 SHA-256、单脚本结构、空 `data`、内嵌构建身份、仓库与 content SHA-256；两类响应都在传输完成后重新读取 Release 并锁定 Tag、Asset ID／名称／大小／digest／状态。返回的字节与作者 Release 完全相同，Hub 仍须独立执行原有校验。

元数据上限 64 KiB、Package 上限 16 MiB；查询／元数据每次最多 15 秒、Package 下载最多 60 秒、整次操作最多 90 秒。最多同时 4 个传输任务、每 IP 2 个，每 IP 每分钟 12 次；超过返回 429。客户端断开、Hub 取消或服务关闭会中止上游请求。没有持久文件缓存。错误仍为上述 JSON，可能包括 `origin_denied`、`invalid_relay_request`、`asset_not_allowed`、`digest_mismatch`、`release_changed`、`upstream_timeout`；失败响应不包含文件片段。

项目示例（Development Fixture）：

```json
{
  "id":"opaque-registry-entry-id",
  "extensionId":"development.fixture",
  "name":"Development Fixture",
  "description":"Explicit test data",
  "author":"Fixture Author",
  "submitter":{"displayName":"Development Fixture User","avatarUrl":null},
  "sourceType":"github",
  "sourceUrl":"https://github.com/example/fixture",
  "icon":null,
  "tags":["test"],
  "version":"1.0.0",
  "github":{
    "owner":"example","repo":"fixture",
    "compatibility":"external",
    "manifest":null,
    "release":{"id":1,"tag":"v1.0.0","version":"1.0.0"},
    "reason":"没有符合规范的可安装 Release"
  },
  "createdAt":"2026-01-01T00:00:00.000Z",
  "updatedAt":"2026-01-01T00:00:00.000Z"
}
```

Discord 项目 `github`、`version`、`extensionId` 为 null。只有 `type === "tavern_extension"`、`distribution === "managed_install"` 且 `github.compatibility === "installable"` 可显示机器安装能力，但 Hub 必须直接向作者 GitHub 重新检查，不能信任此缓存结果的 Hash。目录版本按 15 分钟缓存刷新作者 Release，不需重新投稿，已安装版本检查由 Hub 直接访问作者 Release。

## Discord 登录交接

1. Hub 点击时同步打开弹窗，生成只保存在当前内存的 32 字节随机 `codeVerifier`，其 SHA-256/base64url 为 `codeChallenge`。
2. `POST /api/auth/start {codeChallenge,returnOrigin}`，Origin 必须在 allowlist 且与 returnOrigin 一致。返回 `{authorizationUrl,requestId,handoff:"poll-v1"}`。
3. 弹窗通过 `/api/auth/authorize` 设置 host-only、HttpOnly、SameSite=Lax、生产 Secure 的一次性 Cookie，Path=/api/auth/callback。Cookie 只绑定顶层 OAuth 回调，不是 Hub 跨站会话。
4. Discord 官方 OAuth 使用 `identify guilds`，服务端验证一次性 state/Cookie 后交换 Token 并同步 Profile。Discord Token 和内部 User ID 不传给 Hub。
5. Hub 每 3 秒或返回焦点时 `POST /api/auth/complete {requestId,codeVerifier}`。待授权时返回 202 `{status:"pending"}`；成功结果只可领取一次，绑定原 Origin、requestId 和 verifier。任意错误来源、错误 verifier、未知/过期请求均拒绝，不消耗合法结果。每个流程至多 40 次/分钟，并受全局限流约束。
6. 返回 `{token,expiresAt,profile:{displayName,avatarUrl},isAdmin,canSubmit}` 后 Hub 使用内存 Registry Bearer Token 请求 `/api/me`，确认后通知「我的」刷新。所有 Hub API 请求均 `credentials: omit`；CORS 显式允许 Origin 和 Authorization，无需 Access-Control-Allow-Credentials 或第三方 Cookie。
7. 回调仍尝试严格 targetOrigin 的 postMessage，作为轮询唤醒提示；成功回调页在 1.5 秒后尝试自行关闭，浏览器拒绝关闭时显示手动返回提示。Hub 检查 origin/source/requestId，但消息丢失、opener=null、COOP 断开后的 popup.closed 不影响新协议。旧 `/api/auth/exchange {code,requestId,codeVerifier}` 保留兼容，与 complete 共享一次性消费状态。
8. state/待授权交接最长 5 分钟，成功结果保留 60 秒。取消、超时、切换 Registry、退出或 teardown 停止轮询并忽略迟到结果；重载需要重新登录。仅关闭弹窗不会立即结束新协议，因为浏览器隔离也会呈现 closed；未完成授权会在截止时间明确失败。

OAuth Secret、Discord Token、verifier 和 Registry 会话不写 URL 或持久浏览器存储。服务重启丢失内存交接时安全失败，需要重新登录。回调显示完成只代表 Discord 交换成功；Hub 显示头像/名称才代表交接和 current-user 校验完成。

## Authenticated

- `GET /api/me` → `{profile,isAdmin,isOwner,canPublishOfficial,canSubmit}`。
- `POST /api/auth/logout {}` → `{ok:true}`，服务器立即删除当前会话。
- `GET /api/submissions` → `{items}`，只返回本人投稿，额外含 `status`（listed/unlisted）、`moderation`（visible/hidden/unlisted）和 `moderationReason`。
- `GET /api/github/preview?url=https://github.com/owner/repo` → GitHub 发现对象，供表单预填；必须让用户确认展示信息。
- `GET /api/discord/verify?url=<Discord channels URL>` → `{sourceUrl,guild:{id,name,iconUrl},member:true}`。需登录且可投稿，每账号 10 次/分钟；只返回当前账号已加入的指定服务器，不读取帖子内容、不保存可见范围、不返回全部服务器列表。无成员资格 403，上游不可用 503，会话失效 401。保存仍重新验证，不能用这个结果作为授权凭据。
- `POST /api/submissions` → 201，新项目默认 listed，GitHub visibility 默认 public，Discord 强制 discord_guild；不会扫描仓库自动创建条目。
- `PATCH /api/submissions/:id` → 修改本人展示字段，不能更改 owner、ID、缓存版本或内部字段。
- `POST /api/submissions/:id/status {status:"listed"|"unlisted"}`。

创建字段：`name`（1–100）、`description`（1–2000）、`author`（1–100）、`sourceType`、`sourceUrl`、可选 `icon`、`tags`（最多 8 个，每个最多 30 字符）、`visibility` 与 `visibilitySourceUrl`。GitHub 来源可补充 `discordPostUrl`（仅正式 Discord channels URL），它只是导航资料，不验证作者、帖子内容或安装能力，不要求成员资格。Discord 来源不接受辅助 `githubUrl` 或 `discordPostUrl`。

Hub 0.8.0 兼容：请求仍接受 `githubUrl` / `discordUrl`；主来源别名必须与 `sourceUrl` 一致，GitHub 的 `discordUrl` 映射为 `discordPostUrl`。同时传入新旧发布帖字段时必须一致。PATCH 只编辑旧别名仍可更新或清空辅助链接；未提供时保留。DTO 保留派生字段：GitHub `githubUrl=sourceUrl, discordUrl=discordPostUrl`；Discord `githubUrl=null, discordUrl=sourceUrl, discordPostUrl=null`。数据库不再重复存储别名。编辑允许同一字段集合；sourceUrl 重新验证并重新产生仓库发现信息，不继承旧仓库 Hash。

## Governance

见 [权限、类型与保留规则](GOVERNANCE.md)。治理接口只存在 Registry Web Console，所有操作均服务端验证。

- `GET /api/admin/submissions?page=1`：Admin 仅未保护 Community，Owner 全部；只有 Owner 响应含内部身份追溯字段。
- `POST /api/admin/submissions/:id/moderation {action:"hide"|"restore",reason}`：Admin 限 Community；Owner 任意。
- `POST /api/admin/submissions/:id/classification {classification:"official"|"community",reason,projectIdentityKey}`：仅 Owner；身份切换及审计原子提交，降级保留保护。设置 official 必须回传管理列表当前卡片的 `projectIdentityKey`；缺失或项目快照已变化返回 409 `project_changed`，刷新并重新核对后再授权。该字段是服务端从项目定位字段派生的校验值，不是权限凭证或新的身份字段。
- `POST /api/admin/submissions/:id/protection {enabled,reason}`：Owner only。
- `POST /api/admin/submissions/:id/security-hold {enabled,reason}`：Owner only。
- `POST /api/admin/identities/:discordId/ban {banned,reason}`：Owner only。
- `POST /api/admin/identities/:discordId/roles {role:"admin"|"official_publisher",enabled,reason}`：Owner only。
- `GET /api/admin/identities?page=1`、`GET /api/admin/audit?page=1`：Owner only，50 条分页。

治理写入原因必填（1–500 字符）；无编辑他人内容、变更 Owner 根身份的接口。Recover 不覆盖投稿者的 Soft Unlist。

投稿支持 `type`、`distribution`、`platforms`、`websiteUrl`。`classification` 是平台赋予的扩展身份，所有新投稿均为 community；POST 请求 official 拒绝，PATCH 只允许回传原值，不能修改身份。所有角色（含 Owner）修改身份都必须使用上述治理接口。未知/内部字段（如 `official:true`、`submitted_by`）被拒绝。

Public DTO 返回 `classification:"official"|"community"`，与 `author`、认证账户的公开 `submitter` profile 独立；不返回 submitter/owner ID、Hold、Retention 或审计。旧记录缺失或非法值在 Store、Catalog、普通编辑、治理和 Admin 列表中统一按 community；客户端显式传入非法 classification（包括 null）仍返回 400 `invalid_classification`；普通 Manifest 的同名字段不具备身份权威。`canPublishOfficial` 为兼容保留，仅 Owner 为 true；历史 `official_publisher` 角色不再获得任何身份修改权。

Official 投稿的项目定位字段不可直接变更，Owner 编辑本人内容也一样：sourceType、规范化 sourceUrl、产品 type、websiteUrl、GitHub owner/repo、Manifest id/repository。GitHub 项目的讨论帖链接不改变其安装项目身份。必须先由 Owner 降为 community，再修改项目，最后重新确认 official。版本、名称、作者、简介等内容维护不视为项目身份变化，分发方式仍是独立维度。

PATCH 在最终写入事务中检查最新记录，项目不匹配返回 409 `official_project_identity_mismatch`，不更新内容或自动降级。Catalog 自动 refresh 使用同一检查，冲突时保留已接纳记录并写入 Owner 可见的 `project_identity_mismatch` 审计（actor=`server-refresh`，含原项目和 attempted 项目）；Catalog 仍可读取最后接受的记录。相同冲突不重复写审计。普通 refresh 只更新 GitHub 缓存，不覆盖身份、保护、Hold 或 moderation。

### 0.1.2 GitHub 配额错误

上游匿名配额耗尽时返回 HTTP 429：`error.code = github_rate_limited`、`error.retryAt = ISO 时间`，以及准确的 `Retry-After` 秒数。冷却期间不重复请求 GitHub，不返回上游原始正文或 IP。普通网络失败仍为 502，与 Origin 拒绝区分。

仅对验证过的仓库名称／公开状态和机器元数据使用 2 分钟进程内缓存，每类最多 64 条，机器元数据每条最多 64 KiB，软件包不缓存或落盘。每次调用仍重新读取 Release 并在返回前再次验证 Asset 锁；缓存元数据每次重新检查 digest。服务重启缓存清空。

## Guild ACL 投稿字段

GitHub 的 `visibility` 默认 `public`；选择 `discord_guild` 时，通过正式 Discord `channels/<guild>/<channel>[/<message>]` parser 确定范围。`visibilitySourceUrl` 与辅助 `discordPostUrl` 独立；未提供范围时兼容以发布帖（含旧 `discordUrl` 别名）为依据。公开 GitHub 项目补充 Discord 发布帖不会触发成员验证。

Discord 来源始终 canonicalize 为 `visibility=discord_guild`、`visibilitySourceUrl=sourceUrl`、Guild ID 来自主原帖。旧客户端传 public 也不能公开它；PATCH 同样强制规范，显式范围若与主来源冲突则拒绝。客户端不得传入内部 Guild ID、owner 或授权信息。

投稿、编辑受限记录和重新上架均重新验证投稿者当前属于该 Guild。复用原 Catalog ACL：未登录仅见公开 GitHub；登录者另可见自己当前所属 Guild 的 GitHub / Discord 项目；无资格时列表、搜索、数量和详情均不泄露记录。只确认 Guild 成员资格，不确认作者身份、channel/message 读取权限或帖子内容。

本人投稿 DTO 附加 `visibilitySourceUrl` 便于编辑；公开 DTO 不提供内部 Guild 字段或成员列表。辅助发布帖随有权可见的条目展示，旧私有 `visibilitySourceUrl` 不会被迁移为辅助发布帖。

同一投稿者的重复来源会被拒绝；不同身份可以提交同一来源，不能据错误响应探测其他人的受限记录。数据库的 Catalog UUID 区分记录；没有“认证作者”推断。禁止恶意堆积由限流、每人总量和管理员治理处理。

Discord API 不可达、限流或凭据过期时不使用旧的“成员”结果放行。服务器仅在当前 Session 的内存授权上下文中保存 access token；重启后已有数据库 Session 不能恢复 Discord 授权，客户端需重新登录。

### 账号受限状态与治理控制台

OAuth exchange/complete 和 `GET /api/me` 增量返回布尔字段 `banned`，表示当前认证账号是否受限；保留 `canSubmit`、`isAdmin`、`isOwner` 等兼容字段和全部服务端授权语义。账号显示优先级为 banned=true → 受限用户，否则 isAdmin=true → 管理员，否则普通用户。Owner 仍保留 isOwner=true，普通 Hub 界面显示管理员。旧 Registry 缺少 banned 时客户端不根据 canSubmit 猜测受限身份。

Owner 的账号治理列表返回 isOwner/isAdmin 标志，供 UI 标注根身份保护；服务器仍独立拒绝修改 Owner。`/admin.css` 为公开静态样式，不含账号数据。治理列表中的操作先展示目标、稳定标识与原因输入；确认后才提交既有治理 API，取消不发送治理请求。

### Product declaration and install capability

Product types remain `tavern_extension`, `standalone_app`, `web_tool`; GitHub
Language is not used. Catalog admission is independent of machine installation.
The submission UI exposes no editable distribution field. Registry derives and
persists `distribution` from source/type and its own GitHub inspection:

- GitHub Tavern: verified `compatibility=installable` → `managed_install`;
  absent/invalid Package on a valid public repository → `external_release`.
- Discord Tavern: `external_release`, with the existing mandatory Guild-only ACL.
- Standalone: `external_release`; Web Tool: `open_url` (HTTPS website required).

Create/edit re-inspects GitHub Tavern even after a preview, then canonicalizes the
result. No Package does not invalidate a public repository or require a Discord
source. The preview is informative, not a submission gate. Legacy distribution
hints are accepted as known enum values but cannot grant installability; an
explicit managed_install request for Discord/non-Tavern is rejected. A legacy
Discord open_url hint is stored and returned as external_release. Governance
independently checks the final combination against the actual inspection.

Catalog offers Install only for verified managed-install Tavern entries;
external GitHub Tavern links directly to GitHub, Discord Tavern to its original
post. Accepted cache refreshes update capability and derived distribution together.
Existing refresh budgets, Official identity protection and retention of a previous
validated cache on invalid/unreadable release refreshes remain unchanged; no cached
result can bypass install-time reinspection.

`github.compatibility=installable` now requires the selected release metadata,
manifest/API/repository identity, actual package bytes/hash/size, helper-script
structure and build identity/content hash to agree. Catalog inspection and the
download relay share `package-validation.js`; downloaded code is never executed.
Inspection may download up to 16 MiB using the existing allowlisted bounded
transport. Preview/cache TTL and refresh budgets still apply. Invalid/unreadable
packages stay external; safe display prefill can still be supplied.

Cached Catalog data never authorizes installation. Hub re-inspects before install,
checks the Catalog extension ID still matches, then independently verifies the
locked release, exact package bytes, structure and compatibility before writing.
Changing a release or claiming a product type cannot bypass these checks. Machine
compatibility is not a safety audit and never assigns Official classification.
Shortcut Launcher is an opt-in Runtime presentation capability, not a Catalog type.
