# 存储、迁移与备份

0.3.0 使用 Node 内置 SQLite（单个 Registry 实例、WAL、外键约束、事务、busy timeout）。`src/store.js` 是 SQL Repository 边界；HTTP 权限和业务流程在 `src/app.js`，更换数据库时可实现同一 Repository 操作，不需更改 Hub API 或重写 OAuth／业务流程。

| 表 | 范围 |
|---|---|
| identities | Discord Snowflake 主键、最新显示名／Username、随机头像引用、更新时间、封禁状态 |
| avatars | 受限 Discord PNG 与随机 key；不公开原始 CDN Snowflake URL |
| sessions | HMAC 后的 Registry 随机 Token、内部身份、原始 Origin、过期时间；不保存原 Token |
| submissions | 独立 UUID、内部 owner、Author、展示字段、来源、受限 GitHub 发现快照、owner_status、moderation、visibility、内部 Guild ID、Discord 链接解析信息、时间 |
| audit | 操作者内部 ID、操作、对象、原因、时间；仅私有数据库 |

Discord OAuth access_token／refresh_token、Email、密码从不入库。OAuth access token、state 和一次性 bridge 仅在服务器内存中，过期或重启失效。不保留 refresh token。Profile 每次登录更新，Submission owner 始终绑定 Snowflake。更换 Display Name／Username 不转移所有权。

本地待验收实现使用 `PRAGMA user_version=5`；已发布 Registry 0.5.0 生产仍为 schema 4，本轮不部署。升级前停止旧版本服务并执行一致性备份；不要让旧版与新版同时访问同一数据库。v1 → v2 在一个事务中复制既有 submissions 的全部字段／ID，添加可见性与 Discord 链接字段，旧记录默认 public；来源唯一约束改为 `(owner_id, source_url)`，避免通过全站重复来源错误探测其他人的受限条目。身份、Session、头像和审计不重建；迁移失败回滚。不要让旧版程序打开新 Schema，恢复旧版时使用升级前快照。各级 Schema 升级在各自事务中完成，发现未来更高版本立即拒绝打开。

运行 `npm run backup` 使用只读连接和 SQLite 官方一致性备份 API，将快照存到被忽略的 `backups/`（可用 `BACKUP_DIRECTORY` 覆盖），不迁移或创建原数据库。不要在正在写入时只复制主 .sqlite 文件而遗漏 WAL。恢复时停止进程，保留故障数据库和 WAL 的私有备份，再将经验证快照放到 DATABASE_PATH，清理仅属于该数据库的旧 WAL/SHM 后启动。生产恢复步骤应由运维复核并先在隔离副本演练。

`data/`、`backups/`、*.sqlite、*.db、WAL/SHM、.env 被 Git 忽略。数据库目录默认 0700；操作系统账户仍须限制访问。备份含内部 Discord ID 和投稿审计记录，不能作为公开 Release 附件。

测试使用内存数据库或系统临时目录隔离数据库，不读取 DATABASE_PATH、生产 .env 或真实用户数据。重启与备份恢复已有自动测试。第一版不支持多服务器并发共享 SQLite 文件、集群 Session 或分布式限流；迁移到 Postgres 等后端时保留公共 UUID／Discord 身份键和审计关系。

## v2 → v3

单事务增量 ALTER，保留所有旧列及值，增加不可变 submitter、classification/protection/hold、产品类型/分发/平台/网站、下架期限；新增 roles 和一次性迁移标记；审计增加 before/after。旧身份不提升为 Owner，全部记录初始 Community；已验证 Package 的 GitHub 记录迁移为 Tavern managed_install。迁移失败事务回滚。旧程序拒绝 v3，代码回退必须使用隔离验证过的 v2 快照，不可直接让旧代码操作新库。生产升级先隔离写入、备份及验证，然后迁移；恢复路径保留旧程序、数据库快照与运维检查脚本。

## v3 → v4

单事务增加 `github_url` / `discord_url`，仅从既有主来源填充对应链接。旧 `visibility_source_url` 保持私有，不自动公开；所有原列、账号、治理状态、审计和项目 ID 保持不变。重复打开不会重复迁移。当时的迁移工具生成 v4 候选；当前工具行为见下节。部署前需一致备份；旧程序拒绝 v4，不能仅回退代码而继续使用 v4 数据库。

## v4 → v5（待验收，未部署）

`submissions` 链接模型为 `source_type, source_url, discord_post_url, website_url`。GitHub 主仓库只存 source_url；可选发布帖从旧 discord_url 迁移。Discord 主原帖只存 source_url，discord_post_url=NULL，旧辅助 GitHub 不保留。移除冗余 github_url / discord_url，通过 DTO 派生兼容字段支持 Hub 0.8.0。

一个 BEGIN IMMEDIATE 事务中，先用正式 Discord parser 验证所有旧 Discord source / GitHub 辅助发布帖，再添加新列、复制发布帖、规范 Discord ACL 与分发方式、删除两个冗余列并提交 schema 5。Discord 统一 guild-only，Guild 来自 source_url，范围依据为原 source_url。无猜测字符串或外部抓取；非法历史链接使整个 v4→v5 回滚。重复打开跳过迁移，未来 schema 拒绝打开。

ID、owner/submitter、主 source_url、内容、分类、保护、Hold、下架/保留期、GitHub/Discord metadata、审计与时间戳保持原值；GitHub 的既有 ACL 也保持原值。除 Discord ACL 外，distribution 也按 source/type 和已有 github_json.compatibility 推导：只有存量已验证 installable 的 GitHub Tavern 保留/获得 managed_install，其余 Tavern 为 external_release，Standalone 为 external_release，Web 为 open_url；不伪造 Package 检测结果，安装仍须重新验证。GitHub official 项目 key 不受辅助发布帖影响；Discord 主来源仍受 official 保护。

2026-09-29 经现有 Workbench 只读查询确认：生产 schema 4，仅 1 条 github/public，Discord 记录为 0。未做生产迁移。测试构造包含公共/受限/官方/隐藏/保留记录的 v4 数据，验证允许差异、事务回滚、完整性、幂等和旧客户端 DTO。

`tools/migrate-verified.mjs` 当前从 v2 / v3 / v4 一致性备份生成隔离 v5 候选；逐列核对，唯一允许的旧列变化为冗余链接删除、Discord ACL 与上述 distribution 规范化，另核对发布帖迁移。在线源库不替换。将来部署必须重新确认备份和只读来源统计，按 DEPLOYMENT.md 执行复制库演练、完整性和恢复验证；回退旧程序需恢复对应旧 schema 快照，不能让已发布 0.5.0 直接打开 v5。未授权前不要在生产运行新 openStore 或迁移工具。
