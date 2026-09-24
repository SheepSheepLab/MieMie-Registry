# Governance v1 / Registry 0.3.0

角色可以叠加；每个请求从服务端重新判断，客户端角色显示不是授权。

| 能力 | Submitter | Official Publisher | Admin | Owner |
|---|---|---|---|---|
| 投稿、编辑本人内容、Soft Unlist/Relist | 是 | 是 | 是 | 是 |
| 将本人投稿声明为 Official | 否 | 是 | 否 | 是 |
| Hide/Recover 未保护 Community | 否 | 否 | 是 | 是 |
| Hide/Recover Official 或保护记录 | 否 | 否 | 否 | 是 |
| Ban/Unban、授予/撤销角色 | 否 | 否 | 否 | 是 |
| Protection、Security Hold、完整审计 | 否 | 否 | 否 | 是 |
| 编辑他人内容 | 否 | 否 | 否 | 否 |

Owner 来自服务器私有 `MIEMIE_OWNER_DISCORD_ID`，不能通过 API/Console 修改或封禁。Admin 与 Official Publisher 在 `roles` 表中保存，不形成权限等级链。旧 `MIEMIE_ADMIN_DISCORD_IDS` **仅在首次启动新版时导入一次**，写入 bootstrap 审计及完成标记；以后撤销角色不会被旧环境变量复活。完成后可移除旧变量。旧 Admin 不自动成为 Owner。

默认所有投稿都是 Community，不根据 Author、仓库组织名或 Profile 猜测 Official。Owner/Publisher 可以通过「我的」将自己的投稿设为 Official，默认开启 moderation protection。撤销 Publisher 后不能继续编辑 Official 内容或创建 Official；其已有记录仍保留原分类，不自动下架。可改为 Community 后管理。Admin 即使移除保护也不能管理 Official；只有 Owner 能更改保护。

封禁保留身份与历史记录，仍允许登录、读取目录、查看本人投稿和退出；禁止投稿、编辑、上下架、资料预览及治理写入。已有项目不会因 Ban 自动隐藏，Owner 按需另行 Hide。禁止所有人编辑他人内容；没有平台代编接口。

## 目录类型

`sourceType` 仍为 github/discord；`type` 为 tavern_extension、standalone_app、web_tool；`distribution` 独立为 managed_install、external_release、open_url。类型规则集中于 `productTypes`，数据库使用可扩展 TEXT 字段，未来可增量增加类型而不重建表。

- Tavern Extension：GitHub + verified Package 才能 managed_install；无 Package 可 external_release。Discord 原帖为 open_url。
- Standalone App：external_release，仅跳转 GitHub Release 或 Discord 原帖。不下载/执行 EXE、DMG、APK，不要求 Tavern Manifest。
- Web Tool：open_url，另填 HTTPS `websiteUrl`，来源仍需 GitHub Repo 或 Discord 原帖作为目录来源。网站只用于用户导航，Registry 不抓取。
- 可选 `platforms`：windows/macos/linux/android/ios/web。

GitHub 元数据预览不会创建记录。已安装扩展不受 Catalog 下架远程控制；本地安装的来源与更新机制保持原样。

## 追溯与 Retention

`submitter_id` 在创建时来自 Session，`owner_id` 同样来自 Session；第一版无所有权转移。客户端不允许覆盖。所有治理审计包括 actor、action、target、时间、原因和 before/after；不记录 Token/Secret。原有历史审计没有的 before/after 不伪造补写。

Soft Unlist 保留完整记录，设置 `unlisted_at` / `purge_after`（至少 180 天）。重新上架清空期限，再次下架重新计时。旧下架记录迁移时从迁移时间或较晚的 updated_at 起算，避免升级当天误清理。

Security Hold 阻止清理；hidden/unlisted moderation 同样不自动清理。没有启用周期性删除。运维先备份，再可用 `DATABASE_PATH=... node tools/retention.mjs --dry-run` 查看符合条件数量；真正删除需要明确 `--purge`。删除后保留身份及审计，purge 审计保留投稿者、所有者和来源。不要在备份前清理。

## 独立管理后台

`/admin` 是公开的无数据登录壳；通过同一 Discord OAuth 和 origin-bound Registry Session 登录，后台 API 再验证角色。普通用户无法获取治理数据。Admin 只看到 Community Hide/Recover；Owner 才看到用户角色、Ban、保护、Hold 和审计。Hub 中不包含管理表单或管理请求。

为了维持 Origin 绑定，管理后台与 localhost Hub 不共享 Bearer Token，需要分别完成同一个 Discord 登录流程；不建立第二套账号。Token 仅存在页面内存，不进入 URL、持久存储或日志。same-origin GET 通过浏览器 Sec-Fetch-Site 与 Bearer 验证，不允许跨源伪装登录。

## Owner 首次初始化

部署前在私有 Workbench 交互终端以 root 运行 `python3 /opt/miemie-registry/releases/0.3.0/tools/configure-owner.py`。从已登录身份的显示名和用户名中选择本人，输入 OWNER 确认；工具不回显 ID，只原子写入 mode 0600 私有环境文件。不会覆盖已有 Owner。随后重启 Registry。不得把配置文件、身份列表或 Secret 上传到 Git/聊天。

## 自动验证

`npm test` 包括 API 越权、角色撤销、Ban、Official、Guild ACL、v2 原实现迁移、失败回滚和离线迁移候选验证。无测试读取生产数据。

独立 Console HTTP/DOM 组合验证使用 Mock Discord 与真实本地 Registry HTTP：`node tests/admin-console-contract.mjs --jsdom-module /path/to/jsdom/lib/api.js`。该可选组合验证显式接收已安装的 jsdom 测试工具路径；Registry 基础构建/测试无第三方依赖，不查找其他项目源码。浏览器真实 Discord 授权仍需上线后人工确认。
