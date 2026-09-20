# 安全边界与验证

- Discord OAuth 只请求 identify。浏览器绑定、一次性 state（5 分钟）、一次性桥接码（60 秒）、Origin 和 SHA-256 verifier 绑定分层验证。返回 Hub 的不是 Discord OAuth Token。
- Registry Session 使用随机 256-bit Token，数据库仅 HMAC 哈希，8 小时默认过期。认证绑定 Origin，Mutation 必须来自精确 allowlist，非 Cookie 认证避免第三方 Cookie 和 ambient-cookie CSRF。
- 公开 DTO 字段白名单，Discord ID 不进入 Public／我的/Profile 响应；管理员受限接口才取得必要管理 ID。公开头像使用随机服务端 URL。
- GitHub API 请求只构造固定官方域名，公开 Repo 必须匹配用户指定地址；API 重定向默认拒绝，Release Asset 重定向只接受 GitHub 官方域名；不使用第三方代理、用户 GitHub Token、任意 URL 抓取或 Registry 软件镜像。
- Release metadata ≤64 KiB、请求 15 秒、可中止且限制实际流字节；核对 GitHub API size/digest。Hub 再次对 Package 内容、Manifest、版本、Hash 校验，Registry 兼容标签不能替代安装验证。
- Discord 原帖只接受固定官方 channels URL，禁止附件、Invite、非 HTTPS 或用户密码信息 URL。
- Icon 第一版只有受限 GitHub HTTPS URL／Manifest 安全相对路径，没有上传接口，因此不接受 multipart、data URL 或任意图片字节。Discord 头像只抓取固定 CDN、最大 256 KiB、PNG MIME+signature，不回传带 Snowflake 的源地址。
- 所有投稿文字是数据；Hub 必须使用 textContent 等安全 DOM API，不能拼接 HTML。Registry HTML 不包含投稿文字；OAuth callback 使用 CSP nonce、转义 JSON、精确 postMessage origin。
- 限制请求体 16 KiB、名称/描述/标签长度、分页、每 IP 请求、登录次数、每人投稿次数和总数，来源 URL 全库唯一。SQL 参数绑定、事务原子审计。异步上游返回后再次检查封禁状态。
- 管理员角色只在服务器按当前 ID allowlist 判定。下架／隐藏不删数据，编辑不能转移所有权。管理员恢复不覆盖作者主动下架状态。
- 数据库、.env、Secret、Session、OAuth Token 不进入 Git 和客户端。测试凭据均有 test-only / Development Fixture 标记，生产服务没有 Mock 登录路径。

自动测试覆盖完整 HTTP OAuth 桥、过期、重放、Cookie/Origin/verifier、Session、所有权、Profile 同步、公开 DTO 泄漏、投稿编辑上下架、管理员、封禁、分页、搜索、来源校验、SQLite 持久化和备份，以及独立 Discord/GitHub Adapter 的错误/超时/digest/大小/版本测试。

自动测试不代表真实 Discord OAuth、浏览器跨源下载、Tavern 脚本 API 或生产反向代理已经验证。没有真实 Secret 时请保留这一区分。

已知 MVP 边界：Catalog 发现快照在投稿／编辑时产生；已安装更新由 Hub 直接检查作者 GitHub。头像失败使用 fallback；没有 Icon 上传；没有完整代码沙盒或安全审核。拥有有效 Package／Hash 只说明完整性和格式兼容，不证明代码安全。投稿、编辑与安装界面应准确呈现这些事实。
