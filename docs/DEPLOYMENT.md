# 本地与部署准备

Registry 0.2.0 可以独立运行，无需 Hub／Polisher 源码目录；没有云厂商绑定，也不要求立即购买服务器。

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

开发时空 SESSION_SECRET 自动产生进程内随机值，重启后旧 Session 失效；固定随机值也不会保留 Discord 授权上下文：Discord access token 仅在服务端进程内存，重启后需重新登录才能访问成员目录。真实 Session／Discord 身份仍只在服务端数据库；Hub Token 不做持久存储。

## GitHub 下载 CORS 修复联调

此路径不需要 Discord OAuth 配置或 GitHub Token。Registry 必须能够向 GitHub 官方 API 和 Release Asset 域名发起 HTTPS 请求。

1. 启动 Registry 0.2.0，确认 `/health` 返回对应版本。
2. 将真实酒馆页面的精确 Origin（协议、域名、端口，不含路径）加入 `CORS_ORIGINS`；重启服务。
3. 在 Hub 扩展中心的 Registry 连接设置填写服务地址。酒馆和 Registry 必须满足浏览器 HTTPS／混合内容及本地网络访问规则；远程设备不能将 `127.0.0.1` 当作另一台机器的 Registry。
4. 对作者仓库执行预览／安装。GitHub API 元数据继续直接读取；Asset 受浏览器 CORS 限制时，Hub 可以请求 Registry 受限 relay，服务端校验作者原始字节后转发。

无需自动开启 SillyTavern Proxy，也不会修改用户代理设置。部署反向代理时，此路由不要缓存文件，允许最长 90 秒的上游处理及最多 16 MiB 响应，关闭对此接口的响应内容日志。文件仅临时存在有界进程内存，权威来源仍是作者 GitHub。

## Discord Developer Portal 人工配置

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用，名称和说明准确表明这是 MieMie Registry 登录。
2. OAuth2 页取得 Client ID 和 Client Secret；Secret 只写服务器环境或 `.env`，不要发到聊天、源码、Hub 设置或 GitHub Secrets 以外的公开位置。
3. 注册精确 Redirect URI，例如本地 `http://127.0.0.1:8787/api/auth/callback`。以 Portal 实际接受的 URI 为准；正式上线使用 HTTPS。
4. 此实现仅请求 `identify guilds`，用于资料和服务器成员归属；无需 Bot、邮箱、消息读取或消息内容 Intent。无需手动生成 OAuth URL，Hub 会生成登录链接。
5. 在 Discord 客户端开发者模式复制自己的 User ID，将其填入服务器 `MIEMIE_ADMIN_DISCORD_IDS`。不要把 ID 硬编码进公开源码。
6. 设置 Registry URL 和酒馆 Origin allowlist，启动服务；在 Hub「我的」点击 Discord 登录，确认显示自己的当前公开资料。
7. 测试显示名／头像修改后重新登录，确认 Profile 更新、旧投稿所有权保留。

实现依据 [Discord 官方 OAuth2 文档](https://discord.com/developers/docs/topics/oauth2)：Authorization Code、一次性 state、服务端令牌交换；`identify` 允许读取 `/users/@me`；`guilds` 允许读取 `/users/@me/guilds`。服务器仅使用 ID 判断成员身份，不把服务器列表或 OAuth Token 发给 Hub。Hub 与 Registry 的 verifier 交接是 Registry 自身的一次性会话桥，不声称 Discord 支持未使用的 PKCE 参数。

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

## 最短真实联调

在 Developer Portal 创建应用，添加本地服务实际使用的 `/api/auth/callback` Redirect URI。Client ID 可以提供给维护者配置；Client Secret 只通过本机私有 `.env` 或私密输入渠道设置，不贴到聊天或提交 Git。管理员 User ID 是可选的服务器私有白名单，普通登录投稿不依赖管理员资格。

Hub「我的 → 使用 Discord 登录 → 提交扩展 → GitHub」填写 Polisher 仓库并读取资料、确认提交；「我的」编辑／下架／重新上架；另提交本人所属服务器的 Discord 原帖并选择成员可见，分别用成员、退出登录和非成员身份检查。Guild 限制只是目录可见性，不赋予原 Discord 私有频道阅读权限，也不把公开 GitHub 文件变成私有文件。

## 自动化浏览器回归

在隔离环境运行 `node tests/browser-oauth.mjs --hub <确定版本的HubJSON> --sha256 <该文件SHA256>`，打开输出的本地页面并点击 Start，然后在明确标注的 Mock Discord 弹窗点击 Approve。可添加 `--auto-consent true` 自动通过此测试弹窗的模拟授权；此选项仅存在测试脚本，不进入生产 server.js。

该测试执行真实浏览器 popup、HttpOnly Cookie、CORS、postMessage、一次性会话交接和目录权限请求，使用内存测试库和本地 Mock Discord，绝不连接真实 Discord 或读取私有 `.env`。它不能代替真实 Discord Developer Portal 回调和授权验收。
