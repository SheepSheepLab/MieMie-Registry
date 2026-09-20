# MieMie Registry

MieMie Extension Ecosystem MVP 的独立目录与 Discord 投稿服务，当前版本 **0.2.1**。软件代码 Copyright © 2026 SheepSheep，采用 [GNU GPL v3.0 or later](LICENSE)，SPDX：`GPL-3.0-or-later`。

Registry 只持久保存目录元数据、Discord 投稿身份和必要管理记录。**不托管、缓存落盘或镜像社区 Extension 软件文件，不取得社区作品所有权。** GitHub 软件的权威来源始终是作者自己的仓库／Release；Registry 可按已验证 Manifest 将官方 GitHub Release 字节临时读入有界内存，校验后转发给 Hub，解决浏览器 Release Asset CORS 限制。Discord 项目始终跳转作者原帖。

投稿默认上架，不代表 MieMie 安全审核、作者认证或官方推荐。作品 Author 与 Submitter 是不同字段；Discord 登录只能证明谁提交记录。

只有用户主动提交的记录进入 Catalog；仓库预览不会创建投稿，也不预置 Polisher。

Discord 原帖可以选择“所有人”或“仅该服务器成员”；GitHub 项目可额外提供 Discord 帖子链接作为相同限制的依据。投稿者必须属于该 Guild。权限使用 Guild ID，不使用服务器名称。

## 本地运行

需要 **Node.js 24 或更高版本**（使用内置 `node:sqlite`，Node 24 当前会显示实验性 SQLite 提示）。不依赖其他两个项目目录。

```sh
npm ci
npm start
```

默认只监听 `127.0.0.1:8787`，自动建立 `data/registry.sqlite`。没有 OAuth 配置时公开 Catalog 可运行（初始为空），登录会明确报告尚未配置，不会启用假账号或登录后门。

将 `.env.example` 复制为本地 `.env`，填写自己的 Discord 开发者应用配置，再重新启动。`.env`、数据库和备份均被 Git 忽略。开发测试连接位于 Hub「设置 → 高级 / 开发者选项」，默认折叠；生产 Hub 内置官方 HTTPS 地址，普通用户无需配置。服务端 `CORS_ORIGINS` 必须包含酒馆页面的精确 Origin。

提供 Dockerfile、Compose、健康检查和 SQLite／备份持久卷配置。生产模式缺少真实 HTTPS 地址、OAuth 应用或私有 Secret 时拒绝启动。当前未部署正式公网服务；容器运行、持久卷权限和真实 Discord 授权需在选定托管平台后验证。见 [部署说明](docs/DEPLOYMENT.md)。

```sh
npm run build
npm test
npm run backup
```

`build` 验证源码和纯三段版本，不把 Secret 打包成客户端文件。测试使用临时／内存数据库和显式 Development Fixture，Discord/GitHub 均有 Mock Adapter，不需要真实凭据。真实 OAuth、浏览器 popup/CORS、生产反向代理仍需要部署后的人工联调。

## 功能边界

- 匿名公开目录和登录后按 Guild 成员身份过滤的目录；分页、来源筛选、搜索及详情在服务端执行同一 ACL；公开 DTO 不包含 Discord User ID、Username、Email、Token、Session、封禁信息或管理员名单。
- Discord Authorization Code 登录，只请求 `identify guilds`，不读取消息或邮箱。每次登录刷新显示名／Username／头像；Snowflake 是内部唯一身份和所有权主键。
- 「我的」投稿、编辑、下架、重新上架；下架保留数据库记录。
- 服务端 Discord ID 白名单管理员可以隐藏、恢复、管理下架、封禁和解除封禁。普通用户无法调用管理接口。
- GitHub 公开仓库验证和 Manifest／Release 预填；机器安装兼容性只说明格式可识别，Hub 安装前还必须重新下载并完整校验。
- 无需 Discord 登录的受限 GitHub 文件传输接口；只接受仓库、Release ID、Asset ID，服务端验证机器元数据后只能转发该元数据或其唯一安装包。不是任意 URL 代理；不会把 Registry 标成作品文件来源。Hub 收到字节后仍独立校验 Hash、版本和身份。
- Discord 来源只保存 `discord.com/channels/...` 原帖，不保存临时附件下载地址。
- Icon 第一版只接收 GitHub HTTPS 图片 URL 或 Manifest 中安全相对路径；**没有文件上传接口**。不存储社区 Icon 文件。Manifest Icon → 投稿 Icon → Hub 默认图标。
- 头像由服务端从固定 Discord CDN 获取受限 PNG 并保存到 SQLite，通过随机 URL 提供；公开 URL 不暴露 Discord Snowflake。

Catalog 下架／隐藏不远程删除用户已安装的代码。已安装用户仍可使用本地版本，并直接从原作者 GitHub 检查更新；本阶段没有撤销代码或远程停用机制。

开发模式仅测试 GitHub 安装下载时无需 Discord Client Secret：启动 Registry，将酒馆页面 Origin 加入 `CORS_ORIGINS`，在 Hub「设置 → 高级 / 开发者选项」配置本地服务地址即可。浏览器直接读取 GitHub Asset 失败时可使用此受限传输路径；Registry 未启动、来源不获允许或文件校验失败时仍安全拒绝安装。

## 文档

- [部署与 Discord Developer Portal](docs/DEPLOYMENT.md)
- [API 与 Hub 登录交接](docs/API.md)
- [数据库、备份与迁移](docs/STORAGE.md)
- [安全边界与自动测试](docs/SECURITY.md)

MieMie / 咩咩品牌身份遵循 [BRAND.md](BRAND.md)，不得冒充 SheepSheep 官方版本。当前 Registry 不包含 Logo／角色 PNG；见 [素材范围](ASSETS-LICENSE.md)。品牌说明不向 GPL 软件代码增加商业使用限制。开发运行环境说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
