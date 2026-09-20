# 本地与部署准备

Registry 0.1.0 可以独立运行，无需 Hub／Polisher 源码目录；没有云厂商绑定，也不要求立即购买服务器。

## 一条命令启动

安装 Node.js 24+，首次执行 `npm ci`，以后在项目目录运行 `npm start`。无真实 Discord 配置时服务可以正常启动，但不能登录投稿；不提供生产 Mock 登录。

`.env.example` 只含空值／本机示例，复制到 `.env` 后按下表配置。实际 `.env` 永远不提交 Git。

| 环境变量 | 用途 |
|---|---|
| NODE_ENV | 本地 development；部署 production |
| HOST / PORT | 默认 127.0.0.1 / 8787，按反向代理部署调整 |
| PUBLIC_BASE_URL | Registry 的精确 HTTPS Origin，本机开发可 HTTP |
| CORS_ORIGINS | 逗号分隔精确 Tavern Origins，不使用 `*`；不含路径 |
| DATABASE_PATH | SQLite 路径，默认 ./data/registry.sqlite |
| DISCORD_CLIENT_ID | Discord 应用的公开 Client ID，存服务端即可 |
| DISCORD_CLIENT_SECRET | Discord 应用 Secret，仅服务端 |
| DISCORD_REDIRECT_URI | 必须精确等于 PUBLIC_BASE_URL/api/auth/callback |
| SESSION_SECRET | 至少 32 字符的随机 Secret；生产必填 |
| SESSION_TTL_SECONDS | 会话寿命 60–86400 秒，默认 8 小时 |
| MIEMIE_ADMIN_DISCORD_IDS | 私有 Snowflake 管理员白名单，逗号分隔 |

开发时空 SESSION_SECRET 自动产生进程内随机值，重启后旧 Session 失效；使用本地 `.env` 固定随机值可以保留有效会话。真实 Session／Discord 身份仍只在服务端数据库；Hub Token 不做持久存储。

## Discord Developer Portal 人工配置

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用，名称和说明准确表明这是 MieMie Registry 登录。
2. OAuth2 页取得 Client ID 和 Client Secret；Secret 只写服务器环境或 `.env`，不要发到聊天、源码、Hub 设置或 GitHub Secrets 以外的公开位置。
3. 注册精确 Redirect URI，例如本地 `http://127.0.0.1:8787/api/auth/callback`。以 Portal 实际接受的 URI 为准；正式上线使用 HTTPS。
4. 此实现只请求 `identify`，无需 bot、email、服务器成员或消息权限。
5. 在 Discord 客户端开发者模式复制自己的 User ID，将其填入服务器 `MIEMIE_ADMIN_DISCORD_IDS`。不要把 ID 硬编码进公开源码。
6. 设置 Registry URL 和酒馆 Origin allowlist，启动服务；在 Hub「我的」点击 Discord 登录，确认显示自己的当前公开资料。
7. 测试显示名／头像修改后重新登录，确认 Profile 更新、旧投稿所有权保留。

实现依据 [Discord 官方 OAuth2 文档](https://discord.com/developers/docs/topics/oauth2)：Authorization Code、一次性 state、服务端令牌交换；`identify` 允许读取 `/users/@me` 而不需要 email scope。Hub 与 Registry 的 verifier 交接是 Registry 自身的一次性会话桥，不声称 Discord 支持未使用的 PKCE 参数。

## 真正公开前

- 为 Registry 配置长期稳定 HTTPS 域名、TLS 和 Node 24+ 进程监督；反向代理只转发此服务。
- 配置真实 Secret、Redirect URI、数据库持久卷、最小文件权限、管理员 allowlist。
- 配置准确酒馆 Origin。第一版不开放任意 Origin；新域名需由运维添加。生产允许明确的本机 HTTP 酒馆 Origin（localhost／127.0.0.1），Registry 本身仍必须 HTTPS。
- 反向代理不得记录 Authorization、Cookie、OAuth 回调 `code`／`state` 查询串；应用自身不输出凭据和用户数据日志。
- 当前 IP 限流只信任 socket 地址，不信任用户可伪造的 X-Forwarded-For。反向代理后的流量会共享该额度，公开服务需在可信代理配置独立 IP 限流并按实际规模调整应用限流策略。
- 备份、恢复演练、磁盘监控、滥用处理联系渠道，以及针对实际部署的隐私／数据保留说明。备份包含内部身份数据，不能公开下载。
- 验证浏览器 popup 能保留 opener、Tavern 与 Registry 的 CORS 成功；OAuth cookies 仅在 Registry popup 内使用，不依赖 Hub 第三方 Cookie。
- 不把测试 Fixture 冒充真实社区投稿。没有自动导入假目录。

本阶段没有完成真实 OAuth／生产域名部署验证。自动测试中的 Discord 和 GitHub Adapter 明确为测试注入，生产 server.js 没有对应登录后门或测试账号选项。
