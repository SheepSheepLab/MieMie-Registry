# 本地与部署准备

Registry 0.3.0 可以独立运行，无需 Hub／Polisher 源码目录；没有云厂商绑定，也不要求立即购买服务器。

## 一条命令启动

安装 Node.js 24+，首次执行 `npm ci`，以后在项目目录运行 `npm start`。开发模式无真实 Discord 配置时服务可以正常启动，但不能登录投稿；生产模式缺少真实 HTTPS 地址、明确 CORS Origin、Discord Client ID／Secret 或 Session Secret 时直接拒绝启动。不提供生产 Mock 登录。

`.env.example` 只含空值／本机示例，复制到 `.env` 后按下表配置。实际 `.env` 永远不提交 Git。

| 环境变量 | 用途 |
|---|---|
| NODE_ENV | 本地 development；部署 production |
| HOST / PORT | 默认 127.0.0.1 / 8787，按反向代理部署调整 |
| PUBLIC_BASE_URL | Registry 的精确 HTTPS Origin，本机开发可 HTTP |
| CORS_ORIGINS | 逗号分隔精确 Tavern Origins，不使用 `*`；不含路径 |
| DATABASE_PATH | SQLite 路径，默认 ./data/registry.sqlite；生产必须挂载持久磁盘 |
| BACKUP_DIRECTORY | 一致性备份目录，默认 ./backups；备份也是私有身份数据 |
| DISCORD_CLIENT_ID | Discord 应用的公开 Client ID，存服务端即可 |
| DISCORD_CLIENT_SECRET | Discord 应用 Secret，仅服务端 |
| DISCORD_REDIRECT_URI | 必须精确等于 PUBLIC_BASE_URL/api/auth/callback |
| SESSION_SECRET | 至少 32 字符的随机 Secret；生产必填 |
| SESSION_TTL_SECONDS | 会话寿命 60–86400 秒，默认 8 小时 |
| MIEMIE_OWNER_DISCORD_ID | 私有根身份；仅在服务器初始化 |
| MIEMIE_ADMIN_DISCORD_IDS | 旧管理员一次性导入，之后仅数据库角色生效 |

开发时空 SESSION_SECRET 自动产生进程内随机值，重启后旧 Session 失效；固定随机值也不会保留 Discord 授权上下文：Discord access token 仅在服务端进程内存，重启后需重新登录才能访问成员目录。真实 Session／Discord 身份仍只在服务端数据库；Hub Token 不做持久存储。

## Docker 与持久化部署

仓库提供 Node 24 的 `Dockerfile` 和 `compose.yaml`。镜像只复制显式列出的源码／许可证；`.dockerignore` 使用 allowlist，不发送 `.env`、数据库、备份、测试产物或私有管理员配置到镜像构建上下文。运行用户为 `node`（UID/GID 1000），根文件系统只读；仅 `/data`、`/backups` 持久卷及有界 `/tmp` 可写。没有运行时 npm 第三方依赖。

在服务器配置私有 `.env`，填入真实 HTTPS `PUBLIC_BASE_URL`、明确 `CORS_ORIGINS`、真实 Discord 应用配置、随机 `SESSION_SECRET`；管理员 ID 如需管理功能才填写。然后由运维执行：

```sh
docker compose up -d --build
docker compose exec -T registry node tools/healthcheck.mjs
```

Compose 强制 `NODE_ENV=production`、监听容器 `0.0.0.0:8787`、数据库 `/data/registry.sqlite`、备份 `/backups`。宿主端口只绑定 `127.0.0.1:8787`，再由 HTTPS 反向代理转发；托管平台直接运行镜像时须按平台要求开放容器端口，并明确挂载持久磁盘到 `/data`。不要仅依靠镜像临时文件层，也不要使用 `docker compose down -v` 删除生产卷。

新的 Docker named volume 会继承镜像目录所有权；云平台 bind mount 不保证这一点。首次部署必须确认 `/data` 和 `/backups` 仅对 UID/GID 1000 可写；如挂载为 root 所有，由平台提供的维护步骤对这两个专用目录一次性设置 `chown 1000:1000`、`chmod 700`。不要将应用改为 root 运行，也不要递归修改其他磁盘目录。服务启动会实际打开数据库并运行版本化事务 migration，失败则不开始监听；高于当前支持版本的数据库拒绝打开。健康检查每 30 秒请求 `/health`，只检查服务响应，不代表 Discord/GitHub 外网健康。

HTTPS 可以在受信的 Caddy／Nginx／托管平台入口终止，再以私网 HTTP 转发容器。`PUBLIC_BASE_URL` 和 Discord Redirect URI 始终写外部 HTTPS 地址；不依赖客户端传入的 Host 或 X-Forwarded-Proto 决定安全 Cookie。反向代理保留正常 Origin／Authorization／Cookie 传递，但关闭敏感请求头、响应体和 OAuth 回调查询串访问日志，不能缓存 `/api/auth/*`、个人接口或 relay。不要启用会切断 OAuth popup opener 的 `Cross-Origin-Opener-Policy: same-origin`；部署时用实际浏览器验证 popup 交接。

SIGTERM／SIGINT 停止接收新连接，取消下载转发，最多等待 10 秒后关闭残留连接并关闭 SQLite；Compose 留 15 秒退出窗口。单实例部署即可，SQLite 使用 WAL，数据库层与 HTTP handler 分离；不在同一文件上启动多地域副本。生产 Secret 只通过私有运行环境注入，不使用 Dockerfile 的 ARG／ENV 保存它们。

## 备份、恢复与升级

```sh
docker compose exec -T registry node tools/backup.mjs
```

备份通过 SQLite online backup 从**只读连接**读取当前数据库，包含已提交 WAL，生成一致快照；不会创建或迁移原数据库，也无需加载 OAuth Secret。备份文件权限 0600、目录 0700，包含内部 Discord 身份、投稿和审计信息；定期转存到受限离机位置并演练恢复。生产数据和备份目录不得挂到公开静态站点。

升级前先做备份，再更换镜像；首次启动自动执行 `PRAGMA user_version` 控制的事务 migration。恢复时先停止 Registry，保存现有数据库及 WAL／SHM 作为独立恢复材料，再把选定一致备份放回持久磁盘的 `registry.sqlite`，确保目标目录没有旧数据库残留的 WAL／SHM 并恢复 UID/GID 1000、文件 0600，最后启动和检查 Catalog。不要在服务运行时直接覆盖 SQLite 文件；恢复数据库不恢复内存中的 Discord 会话，用户需重新登录。

当前开发机器没有 Docker 引擎，镜像和 Compose 尚未在容器中实际启动；自动测试覆盖真实 Node 服务监听／健康／SIGTERM／数据库重启持久化、生产配置拒绝缺项，以及只读一致性备份不迁移源库。选定托管平台后仍须执行容器与持久卷恢复验收。

## GitHub 下载 CORS 修复联调

此路径不需要 Discord OAuth 配置或 GitHub Token。Registry 必须能够向 GitHub 官方 API 和 Release Asset 域名发起 HTTPS 请求。

1. 启动 Registry 0.3.0，确认 `/health` 返回对应版本。
2. 将真实酒馆页面的精确 Origin（协议、域名、端口，不含路径）加入 `CORS_ORIGINS`；重启服务。
3. 开发测试时在 Hub「设置 → 高级 / 开发者选项」启用地址覆盖；生产 Hub 由构建配置一次官方 HTTPS 地址，普通扩展中心不显示服务地址配置。酒馆和 Registry 必须满足浏览器 HTTPS／混合内容及本地网络访问规则；远程设备不能将 `127.0.0.1` 当作另一台机器的 Registry。
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

生产 OAuth 浏览器绑定 Cookie 为 `HttpOnly; Secure; SameSite=Lax`，只用于 popup 回调并在使用后清除；它不是第三方 Session Cookie。Hub 后续持有的 Registry 随机会话凭据仅保存在 iframe 内存，不是 Discord Token；Discord access token 只保存在 Registry 内存。关闭／刷新 Hub 或重启 Registry 后需要重新登录。Owner 由私有配置判断，其余角色在数据库中由 Owner 管理，不接受客户端角色参数。

实现依据 [Discord 官方 OAuth2 文档](https://discord.com/developers/docs/topics/oauth2)：Authorization Code、一次性 state、服务端令牌交换；`identify` 允许读取 `/users/@me`；`guilds` 允许读取 `/users/@me/guilds`。服务器仅使用 ID 判断成员身份，不把服务器列表或 OAuth Token 发给 Hub。Hub 与 Registry 的 verifier 交接是 Registry 自身的一次性会话桥，不声称 Discord 支持未使用的 PKCE 参数。

## 真正公开前

- 为 Registry 配置长期稳定 HTTPS 域名、TLS 和 Node 24+ 进程监督；反向代理只转发此服务。
- 配置真实 Secret、Redirect URI、数据库持久卷、最小文件权限、管理员 allowlist。
- 配置准确酒馆 Origin。第一版不开放任意 Origin；新域名需由运维添加。生产允许明确的本机 HTTP 酒馆 Origin（localhost／127.0.0.1），Registry 本身仍必须 HTTPS。
- 反向代理不得记录 Authorization、Cookie、OAuth 回调 `code`／`state` 查询串；应用自身不输出凭据和用户数据日志。
- 当前 IP 限流只信任 socket 地址，不信任用户可伪造的 X-Forwarded-For。反向代理后的用户会共享应用额度（例如 OAuth 开始 10 次／10 分钟、relay 12 次／分钟）。边缘代理另加每 IP 限流不会解除这层共享额度：多用户正式开放前须根据已确定的可信代理拓扑配置、审查和调整应用限流策略；当前配置适合小规模受控联调，不能声称已完成公网容量验证。
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

治理升级、Owner 初始化和保留策略见 [GOVERNANCE.md](GOVERNANCE.md)。反向代理需转发 `/admin`、`/admin.js` 到同一 localhost 服务，不公开任何文件目录。
