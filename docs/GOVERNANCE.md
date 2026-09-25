# Governance v1 / Registry 0.4.0

角色可以叠加；每个请求从服务端重新判断，客户端角色显示不是授权。

| 能力 | Submitter | Legacy Official Publisher | Admin | Owner |
|---|---|---|---|---|
| 投稿、编辑本人内容、Soft Unlist/Relist | 是 | 是 | 是 | 是 |
| 通过治理入口修改扩展身份（任意投稿） | 否 | 否 | 否 | 是 |
| Hide/Recover 未保护 Community | 否 | 否 | 是 | 是 |
| Hide/Recover Official 或保护记录 | 否 | 否 | 否 | 是 |
| Ban/Unban、授予/撤销角色 | 否 | 否 | 否 | 是 |
| Protection、Security Hold、完整审计 | 否 | 否 | 否 | 是 |
| 编辑他人内容 | 否 | 否 | 否 | 否 |

Owner 来自服务器私有 `MIEMIE_OWNER_DISCORD_ID`，不能通过 API/Console 修改或封禁。Admin 在 `roles` 表中保存。历史 `official_publisher` 行和角色审计为兼容而保留，但该角色不再授予身份修改权；旧角色 API 保持可读写，Console 仅保留撤销旧 Publisher 的入口。`canPublishOfficial` 保留为兼容能力字段，仅 Owner 为 true，不能据此从投稿接口创建 Official。旧 `MIEMIE_ADMIN_DISCORD_IDS` **仅在首次启动新版时导入一次**，写入 bootstrap 审计及完成标记；以后撤销角色不会被旧环境变量复活。完成后可移除旧变量。旧 Admin 不自动成为 Owner。

`classification` 已有且专门表示扩展身份：`official`（🐑官方扩展）或 `community`（🧩社区扩展）。它不是镜像、来源、产品类型或发布渠道，因此复用原字段，不引入第二个同义字段。

所有新投稿（包括 Owner 代发）默认 community。Author 是独立作者显示字段；Submitter 来自认证账户。Author、Submitter、Discord 昵称、用户名、仓库组织名或普通 Manifest 的任何自声明都不能赋予 official。只有 Owner 可通过 `/admin` 或 `POST /api/admin/submissions/:id/classification` 双向切换身份；必须填写原因，与 before/after 审计在同一事务提交。Admin 和历史 Publisher 均被服务端拒绝。

投稿 POST 中的 `classification:official` 对所有账户拒绝；为兼容旧客户端，允许默认 community。PATCH 允许回传原分类但拒绝改变分类；不含分类的普通内容编辑仍可维护已被 Owner 纳入官方的投稿，但不能改变项目身份。存储层的内容更新完全不写分类、保护和 Hold，避免等待外部验证时覆盖 Owner 的最新决定。

提升为 official 默认开启 moderation protection；改回 community 不会清除已有保护。只有 Owner 的 protection 操作可主动解除保护；Admin 即使保护已解除也不能管理 official。身份切换不改变 Author、Submitter、来源、分发方式、可见范围或内容编辑权限。

### Official 绑定的项目

Official 接纳的是当前具体项目。集中比较：sourceType、规范化 sourceUrl、产品 type、websiteUrl、GitHub canonical owner/repo，以及 Manifest id/repository。GitHub 大小写和 `.git` 等价地址不算变更；版本、名称、作者、简介和分发方式不加入该判断。Manifest 从无到有或消失也按身份变化保守处理。

任何账户（包括 Owner 编辑本人投稿）都必须先执行 official → community，才能改变上述项目定位字段；修改后由 Owner 重新确认 community → official。普通 PATCH 和自动 refresh 都不能转移 official 或自动降级。

PATCH、refresh、Owner 授权在 `BEGIN IMMEDIATE` 内重新读取最新项目。refresh 还检查来源和缓存是否已被其他编辑改变；身份冲突保留完整旧记录并记录 `server-refresh / project_identity_mismatch` 审计及原项目/attempted 项目。没有新增状态机或数据库字段。

后台卡片展示只读来源、Extension ID、Website（如有）、Submitter（Owner 可见其稳定 Discord ID）和 Submission ID。授权 official 必须回传卡片中服务端派生的 `projectIdentityKey`；事务内发现项目已变更或确认值缺失就返回 `project_changed`，要求刷新重看。这防止投稿者先改完项目、Owner 再从旧卡片授权的反向竞态。该值仅是项目快照校验，不是另一套权限或身份事实源；治理审计同时记录被接纳的项目。

### Existing data

无需新增列，数据库 schema 仍为 3。已有 v3 记录的明确分类保留；原 v2→v3 迁移继续将旧记录设为 community，将 `owner_id` 回填为 `submitter_id`，不从 Author 推断。Store 的读取边界统一将非精确 `official` 值解释为 community；Catalog、本人投稿、编辑、治理和 Admin 列表使用相同语义，保护状态仍独立生效。Hub 同样安全 fallback。读取不改写旧数据库、无需新 migration；Owner 明确治理时才写入合法分类。客户端新传入非法值（含 null）仍拒绝，不能使用 persisted fallback 绕过输入校验。

本轮没有自动提升 Polisher 或其他记录，也没有修改生产数据。仓库归属或扩展 ID 不能唯一证明某一投稿的身份（不同 Submitter 可以提交同一来源）。部署后 Owner 可核对实际 Catalog 记录，再从现有治理入口明确赋予身份。

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

`/admin` 是公开的无数据登录壳；通过同一 Discord OAuth 和 origin-bound Registry Session 登录，后台 API 再验证角色。普通用户无法获取治理数据。Admin 只看到 Community Hide/Recover；Owner 才看到扩展身份切换、用户角色、Ban、保护、Hold 和审计。Hub 中不包含管理表单或管理请求。

为了维持 Origin 绑定，管理后台与 localhost Hub 不共享 Bearer Token，需要分别完成同一个 Discord 登录流程；不建立第二套账号。Token 仅存在页面内存，不进入 URL、持久存储或日志。same-origin GET 通过浏览器 Sec-Fetch-Site 与 Bearer 验证，不允许跨源伪装登录。

## Owner 首次初始化

部署前在私有 Workbench 交互终端以 root 运行 `python3 /opt/miemie-registry/releases/0.3.0/tools/configure-owner.py`。从已登录身份的显示名和用户名中选择本人，输入 OWNER 确认；工具不回显 ID，只原子写入 mode 0600 私有环境文件。不会覆盖已有 Owner。随后重启 Registry。不得把配置文件、身份列表或 Secret 上传到 Git/聊天。

## 自动验证

`npm test` 包括 API 越权、角色撤销、Ban、Official、Guild ACL、v2 原实现迁移、失败回滚和离线迁移候选验证。无测试读取生产数据。

独立 Console HTTP/DOM 组合验证使用 Mock Discord 与真实本地 Registry HTTP：`node tests/admin-console-contract.mjs --jsdom-module /path/to/jsdom/lib/api.js`。该可选组合验证显式接收已安装的 jsdom 测试工具路径；Registry 基础构建/测试无第三方依赖，不查找其他项目源码。浏览器真实 Discord 授权仍需上线后人工确认。
