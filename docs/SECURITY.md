# 安全边界与验证

- Discord OAuth 只请求 identify 与 guilds，不读取邮箱或消息。浏览器绑定、一次性 state（5 分钟）、一次性桥接码（60 秒）、Origin 和 SHA-256 verifier 绑定分层验证。返回 Hub 的不是 Discord OAuth Token。
- Registry Session 使用随机 256-bit Token，数据库仅 HMAC 哈希，8 小时默认过期。认证绑定 Origin，Mutation 必须来自精确 allowlist，非 Cookie 认证避免第三方 Cookie 和 ambient-cookie CSRF。
- 公开 DTO 字段白名单，Discord ID 不进入 Public／我的/Profile 响应；管理员受限接口才取得必要管理 ID。公开头像使用随机服务端 URL。
- GitHub API 请求只构造固定官方域名，公开 Repo 必须匹配用户指定地址；API 重定向默认拒绝，Release Asset 重定向只接受 GitHub 官方域名；不使用第三方代理、用户 GitHub Token、任意 URL 抓取或 Registry 软件镜像。
- Release metadata ≤64 KiB、请求 15 秒、可中止且限制实际流字节；核对 GitHub API size/digest。Hub 再次对 Package 内容、Manifest、版本、Hash 校验，Registry 兼容标签不能替代安装验证。
- 0.1.1 的公开 Package relay 不接受任意 URL：只接受规范化公开 GitHub 仓库与两个整数 ID，独立从官方 API 找出并验证指定 Release 的 Manifest／机器元数据。只转发元数据和其声明的安装包，不能选择同一 Release 的其他附件。查询拒绝重定向；Asset 的每次重定向在抓取前检查 HTTPS、凭据、端口及固定 GitHub 官方域名，不发送 Cookie／Authorization，不读取客户端提供的 URL。
- relay 在全部校验完成后才发送原始字节；Package 校验包括 API digest、文件及 content SHA-256、身份、版本、空用户 data 和严格宿主单脚本结构，响应前再次读取 Release 锁。最多 4 个在途操作、每 IP 2 个、每 IP 每分钟 12 次；响应大小、单请求和整操作期限均有限制，断开连接即中止。不落盘、不建立社区文件镜像，Registry 日志不得记录签名下载 URL。
- Discord 原帖只接受固定官方 channels URL，禁止附件、Invite、非 HTTPS 或用户密码信息 URL。
- Icon 第一版只有受限 GitHub HTTPS URL／Manifest 安全相对路径，没有上传接口，因此不接受 multipart、data URL 或任意图片字节。Discord 头像只抓取固定 CDN、最大 256 KiB、PNG MIME+signature，不回传带 Snowflake 的源地址。
- 所有投稿文字是数据；Hub 必须使用 textContent 等安全 DOM API，不能拼接 HTML。Registry HTML 不包含投稿文字；OAuth callback 使用 CSP nonce、转义 JSON、精确 postMessage origin。
- 限制请求体 16 KiB、名称/描述/标签长度、分页、每 IP 请求、登录次数、每人投稿次数和总数，来源 URL 同一投稿者内唯一。SQL 参数绑定、事务原子审计。异步上游返回后再次检查封禁状态。
- 管理员角色只在服务器按当前 ID allowlist 判定。下架／隐藏不删数据，编辑不能转移所有权。管理员恢复不覆盖作者主动下架状态。
- 数据库、.env、Secret、Session、OAuth Token 不进入 Git 和客户端。测试凭据均有 test-only / Development Fixture 标记，生产服务没有 Mock 登录路径。

自动测试覆盖完整 HTTP OAuth 桥、过期、重放、Cookie/Origin/verifier、Session、所有权、Profile 同步、公开 DTO 泄漏、投稿编辑上下架、管理员、封禁、分页、搜索、来源校验、SQLite 持久化和备份，以及独立 Discord/GitHub Adapter 的错误/超时/digest/大小/版本测试。

relay 另有真实本地 HTTP 接口测试与 Mock GitHub 上游：无 ACAO 的官方 Asset 重定向、Origin allowlist、匿名访问、SSRF、错误包、任意附件拒绝、Release 变化、限流／并发、期限和客户端断开。浏览器依然必须能连接已配置的 Registry；此功能不绕过浏览器本身的混合内容或本地网络访问策略。

自动测试不代表真实 Discord OAuth、浏览器跨源下载、Tavern 脚本 API 或生产反向代理已经验证。没有真实 Secret 时请保留这一区分。

已知 MVP 边界：Catalog 发现快照在投稿／编辑时产生；已安装更新由 Hub 直接检查作者 GitHub。头像失败使用 fallback；没有 Icon 上传；没有完整代码沙盒或安全审核。拥有有效 Package／Hash 只说明完整性和格式兼容，不证明代码安全。投稿、编辑与安装界面应准确呈现这些事实。


0.1.2 增加配额冷却及短期仓库／元数据内存缓存（每类最多 64 条，2 分钟有效），不缓存软件包；新鲜 Release 前后验证保持不变。错误只返回分类与重试时间，不转发 GitHub 上游正文中的出口 IP 或其他细节。缓存不是在 GitHub 不可达或限流时使用旧锁授权安装的替代路径。

## 0.2.0 Discord Guild 可见性

Catalog 项目的 `public` / `discord_guild` 访问范围与 GitHub / Discord 来源相互独立。Guild 锚点只从经过校验的 Discord 原帖链接提取，客户端不能直接指定内部 Guild ID；选择或修改受限范围、重新上架时检查投稿者的当前成员身份。

Catalog 列表、搜索、总数和单项详情共用服务端 ACL。未知条目与无权条目返回同样的 404，管理员也不能通过普通发现接口绕过成员限制。未登录不查询 Guild，只得到公开项目。Discord 查询失败或凭据过期时不会回退为“成员”。投稿所有权仍按 Discord User ID 判断，与可见性和 Profile 名称分离。

OAuth access token 仅服务端内存保存，绑定具体会话；不写数据库、日志、浏览器或发布包，也不保存 refresh token。会话结束或进程重启后清理，需重新授权登录。数据库只持久保存身份、投稿、ACL 与必要审计记录。Hub 收到的短期 Registry 会话 Token 不是 Discord Token，仅在当前 iframe 内存使用。

公开 GitHub 软件包始终公开可从作者仓库获得；目录 ACL 不声称隐藏互联网上已公开的源仓库或撤销已安装代码。Discord Guild 成员判断也不表示用户拥有某个私有频道的阅读权限。

## 0.2.2 登录交接修复

`poll-v1` 将结果领取绑定到开始登录时的 Origin、随机 requestId 和 SHA-256 verifier。无法获得 verifier 的页面不能查询登录进度、领取身份或抢先消耗结果。结果只在服务器内存中暂存，最长 60 秒；消息交接与主动领取共享一次性消费。返回 Hub 的凭证仍为 Registry 内存会话，Discord OAuth Token 始终留在服务器。

弹窗 postMessage 是可选唤醒提示，不再是单点依赖；Cookie 仍仅用于顶层回调的 CSRF 绑定，禁止通过放宽 SameSite、开放通配 Origin 或取消 verifier 校验解决跨站登录问题。页面关闭/切换服务/退出会丢弃结果；服务重启后必须重新登录。
