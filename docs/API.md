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

Discord 项目 `github`、`version`、`extensionId` 为 null。只有 `github.compatibility === "installable"` 可显示机器安装能力，但 Hub 必须直接向作者 GitHub 重新检查，不能信任此缓存结果的 Hash。目录版本是最后投稿／编辑时的发现快照，已安装版本检查由 Hub 直接访问作者 Release。

## Discord 登录交接

1. Hub 点击时同步打开弹窗，生成只保存在当前内存的 32 字节随机 `codeVerifier`，其 SHA-256/base64url 为 `codeChallenge`。
2. `POST /api/auth/start {codeChallenge,returnOrigin}`，Origin 必须在 allowlist 且与 returnOrigin 一致。返回 `{authorizationUrl,requestId,handoff:"poll-v1"}`。
3. 弹窗通过 `/api/auth/authorize` 设置 host-only、HttpOnly、SameSite=Lax、生产 Secure 的一次性 Cookie，Path=/api/auth/callback。Cookie 只绑定顶层 OAuth 回调，不是 Hub 跨站会话。
4. Discord 官方 OAuth 使用 `identify guilds`，服务端验证一次性 state/Cookie 后交换 Token 并同步 Profile。Discord Token 和内部 User ID 不传给 Hub。
5. Hub 每 3 秒或返回焦点时 `POST /api/auth/complete {requestId,codeVerifier}`。待授权时返回 202 `{status:"pending"}`；成功结果只可领取一次，绑定原 Origin、requestId 和 verifier。任意错误来源、错误 verifier、未知/过期请求均拒绝，不消耗合法结果。每个流程至多 40 次/分钟，并受全局限流约束。
6. 返回 `{token,expiresAt,profile:{displayName,avatarUrl},isAdmin,canSubmit}` 后 Hub 使用内存 Registry Bearer Token 请求 `/api/me`，确认后通知「我的」刷新。所有 Hub API 请求均 `credentials: omit`；CORS 显式允许 Origin 和 Authorization，无需 Access-Control-Allow-Credentials 或第三方 Cookie。
7. 回调仍尝试严格 targetOrigin 的 postMessage，作为轮询唤醒提示；Hub 检查 origin/source/requestId，但消息丢失、opener=null、COOP 断开后的 popup.closed 不影响新协议。旧 `/api/auth/exchange {code,requestId,codeVerifier}` 保留兼容，与 complete 共享一次性消费状态。
8. state/待授权交接最长 5 分钟，成功结果保留 60 秒。取消、超时、切换 Registry、退出或 teardown 停止轮询并忽略迟到结果；重载需要重新登录。仅关闭弹窗不会立即结束新协议，因为浏览器隔离也会呈现 closed；未完成授权会在截止时间明确失败。

OAuth Secret、Discord Token、verifier 和 Registry 会话不写 URL 或持久浏览器存储。服务重启丢失内存交接时安全失败，需要重新登录。回调显示完成只代表 Discord 交换成功；Hub 显示头像/名称才代表交接和 current-user 校验完成。

## Authenticated

- `GET /api/me` → `{profile,isAdmin,canSubmit}`。
- `POST /api/auth/logout {}` → `{ok:true}`，服务器立即删除当前会话。
- `GET /api/submissions` → `{items}`，只返回本人投稿，额外含 `status`（listed/unlisted）、`moderation`（visible/hidden/unlisted）和 `moderationReason`。
- `GET /api/github/preview?url=https://github.com/owner/repo` → GitHub 发现对象，供表单预填；必须让用户确认展示信息。
- `POST /api/submissions` → 201，新项目默认 listed，visibility 默认 public；不会扫描仓库自动创建条目。
- `PATCH /api/submissions/:id` → 修改本人展示字段，不能更改 owner、ID、缓存版本或内部字段。
- `POST /api/submissions/:id/status {status:"listed"|"unlisted"}`。

创建字段：`name`（1–100）、`description`（1–2000）、`author`（1–100）、`sourceType`、`sourceUrl`、可选 `icon`、`tags`（最多 8 个，每个最多 30 字符）、`visibility`（public / discord_guild）与 `visibilitySourceUrl`。编辑允许同一字段集合；sourceUrl 重新验证并重新产生仓库发现信息，不继承旧仓库 Hash。

## Admin

权限来自服务器 `MIEMIE_ADMIN_DISCORD_IDS`，每个请求重新核对，不接受客户端传入角色。

- `GET /api/admin/submissions?page=1` → 50 条分页；只有该管理员接口额外提供必要的 `ownerDiscordUserId`、`submitterBanned`。
- `POST /api/admin/submissions/:id/moderation {action:"hide"|"unlist"|"restore",reason}`。
- `POST /api/admin/identities/:discordId/ban {banned:true|false,reason}`。

restore 只恢复管理层可见性，不覆盖投稿者自己的 unlisted 决定。封禁阻止继续提交、编辑及上下架，仍允许查看与登出。封禁不会自动删除历史作品；管理员按需要另行隐藏。审计记录保留在私有数据库，不进入公开 API。


### 0.1.2 GitHub 配额错误

上游匿名配额耗尽时返回 HTTP 429：`error.code = github_rate_limited`、`error.retryAt = ISO 时间`，以及准确的 `Retry-After` 秒数。冷却期间不重复请求 GitHub，不返回上游原始正文或 IP。普通网络失败仍为 502，与 Origin 拒绝区分。

仅对验证过的仓库名称／公开状态和机器元数据使用 2 分钟进程内缓存，每类最多 64 条，机器元数据每条最多 64 KiB，软件包不缓存或落盘。每次调用仍重新读取 Release 并在返回前再次验证 Asset 锁；缓存元数据每次重新检查 digest。服务重启缓存清空。

## Guild ACL 投稿字段

`visibility` 默认 `public`。`discord_guild` 仅允许从有效 Discord `channels/<guild>/<channel>[/<message>]` 链接确定权限范围；服务器名称不参与判断。Discord 来源直接使用 `sourceUrl`；GitHub 来源需额外提供 `visibilitySourceUrl`。客户端不得传入 `visibilityGuildId`、owner 或其他内部字段。消息／频道实际内容不会被读取，此限制只证明 Guild 成员身份，不是频道访问权限验证。

投稿、编辑受限记录和重新上架均重新验证当前投稿者属于该 Guild；修改来源重新解析，不继承旧 Guild 授权。自己的投稿响应附加 `visibilitySourceUrl` 便于编辑。可见目录只给 `visibility` 标签，不给用户的成员列表或单独的内部 Guild 字段；未经授权完全不返回条目。源 Discord 链接自身仍含其公开结构 ID。

同一投稿者的重复来源会被拒绝；不同身份可以提交同一来源，不能据错误响应探测其他人的受限记录。数据库的 Catalog UUID 区分记录；没有“认证作者”推断。禁止恶意堆积由限流、每人总量和管理员治理处理。

Discord API 不可达、限流或凭据过期时不使用旧的“成员”结果放行。服务器仅在当前 Session 的内存授权上下文中保存 access token；重启后已有数据库 Session 不能恢复 Discord 授权，客户端需重新登录。
