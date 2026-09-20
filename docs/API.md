# Registry API v1

地址以部署的 `PUBLIC_BASE_URL` 为准。除头像与 Package 字节接口外，响应为 JSON；错误格式：

```json
{"error":{"code":"unauthorized","message":"请使用 Discord 登录"}}
```

所有写操作必须携带已允许的 `Origin` 和 `Content-Type: application/json`。认证 API 使用 `Authorization: Bearer <opaque Registry session token>`，并绑定创建会话时的 Origin。浏览器自动设置 Origin。没有 Cookie 认证回退；客户端不得把会话 Token 放入 URL、localStorage、日志或 Catalog。

## Public

- `GET /api/catalog?page=1&pageSize=20&source=github&q=关键词` → `{items,page,pageSize,total,hasMore}`。pageSize 为 1–50；source 可省略或为 github/discord。
- `GET /api/catalog/:id` → 单条公开项目；下架或隐藏项目返回 404。
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

1. Hub 在用户点击时同步创建 popup，生成 32 字节随机 `codeVerifier`（base64url 字符串 43 字符），仅存在当前内存；对其 UTF-8 做 SHA-256，再 base64url 得到 `codeChallenge`。
2. `POST /api/auth/start {codeChallenge,returnOrigin}`。`returnOrigin` 必须等于实际请求 Origin 且在 allowlist。
3. 返回 `{authorizationUrl,requestId}`。popup 导航此 **Registry** URL，设置只在 OAuth 回调使用的 HttpOnly、SameSite=Lax 浏览器 Cookie，再跳转 Discord。
4. Discord 使用正常 Authorization Code + state，Registry 服务端用 Client Secret 换取短期 Discord Token，只向 `/users/@me` 读取资料；不申请 email、guilds 或 bot 权限。
5. 回调验证一次性 state 和 popup 浏览器 Cookie，刷新内部身份资料，发送：

```js
{type: 'miemie-registry-auth', code: 'single-use-bridge-code', requestId: 'matching-request-id'}
```

6. Hub 必须同时检查 `event.origin === Registry origin`、`event.source === popup`、requestId 一致。错误来源直接忽略。
7. `POST /api/auth/exchange {code,requestId,codeVerifier}`。bridge code 60 秒有效且只能使用一次，绑定原始 Origin 和 verifier；返回 `{token,expiresAt,profile:{displayName,avatarUrl},isAdmin,canSubmit}`。
8. Hub 只在当前内存保存 Registry Token。重载后重新登录；不依赖第三方 Cookie。popup 不向父页下发 Discord Token、Discord User ID 或 Secret。

state 5 分钟有效；Cookie 与 state 一次性使用。取消授权、失去 opener、页面重载或过期应让用户重新登录，不从 URL／永久存储恢复敏感会话。

## Authenticated

- `GET /api/me` → `{profile,isAdmin,canSubmit}`。
- `POST /api/auth/logout {}` → `{ok:true}`，服务器立即删除当前会话。
- `GET /api/submissions` → `{items}`，只返回本人投稿，额外含 `status`（listed/unlisted）、`moderation`（visible/hidden/unlisted）和 `moderationReason`。
- `GET /api/github/preview?url=https://github.com/owner/repo` → GitHub 发现对象，供表单预填；必须让用户确认展示信息。
- `POST /api/submissions` → 201，新项目默认 listed。
- `PATCH /api/submissions/:id` → 修改本人展示字段，不能更改 owner、ID、缓存版本或内部字段。
- `POST /api/submissions/:id/status {status:"listed"|"unlisted"}`。

创建字段：`name`（1–100）、`description`（1–2000）、`author`（1–100）、`sourceType`、`sourceUrl`、可选 `icon`、`tags`（最多 8 个，每个最多 30 字符）。编辑允许同一字段集合；sourceUrl 重新验证并重新产生仓库发现信息，不继承旧仓库 Hash。

## Admin

权限来自服务器 `MIEMIE_ADMIN_DISCORD_IDS`，每个请求重新核对，不接受客户端传入角色。

- `GET /api/admin/submissions?page=1` → 50 条分页；只有该管理员接口额外提供必要的 `ownerDiscordUserId`、`submitterBanned`。
- `POST /api/admin/submissions/:id/moderation {action:"hide"|"unlist"|"restore",reason}`。
- `POST /api/admin/identities/:discordId/ban {banned:true|false,reason}`。

restore 只恢复管理层可见性，不覆盖投稿者自己的 unlisted 决定。封禁阻止继续提交、编辑与重新上架，仍允许查看、登出、主动下架。封禁不会自动删除历史作品；管理员按需要另行隐藏。审计记录保留在私有数据库，不进入公开 API。
