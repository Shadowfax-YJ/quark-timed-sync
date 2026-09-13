# 文件修订同步协议 1

订阅可开启“按云端修订记录校验并更新同名文件”。没有记录的文件继续追加下载；
有记录的文件每次计算本地 SHA256，与记录的最新摘要比较。相同则跳过，
不同则下载新对象，完整核对长度和 SHA256 后替换。大小和修改时间不能替代摘要。

## 云端布局

- 原路径继续提供当前版本，例如 `2026-09-05/123/28.zip`。
- `.sync-revisions/objects/<sha256>` 保存修订内容，文件名是完整 SHA256，无扩展名。
- `.sync-revisions/records/<revision_id>.json` 是最后提交的不可变发布记录。
- `.sync-recycle/<previous_sha256>/<原相对路径>` 保留被替换的原件。

同步读取固定对象，所以备份程序再次上传旧同名文件不会导致退回旧内容。
跨账号分享只需转存新增对象和记录；本地从新对象替换，旧转存目录中的同名包不参与判断。
回收目录不转存、不进入普通扫描；协议对象按需下载。

记录包括 `format=quark-file-revision`、`schema_version=1`、`revision_id`、`path`、
`previous_sha256`、`sha256`、`size`、`content_path`、`recycle_path`、`created_at`、
`author`、`reason` 和可选 `changes`。游戏字段和具体改法由外部修订工具负责。
同一路径按前后摘要形成唯一连续链，跨过中间版本可直接更新；未知协议、分叉、循环、
路径冲突或缺失已应用历史均停止更新。哈希证明内容一致，不提供发布者身份认证，须信任订阅来源。

## 本地替换

临时下载位于 `.sync-revisions/staging/`，校验前不占用最终文件名。
旧文件复制到 `.sync-recycle/<实际旧摘要>/<原相对路径>` 并校验；下载期间发生本地编辑则停止。
之后先持久化 `pending/` 日志，原子替换并保存 `applied/` 记录；替换后中断会补齐记录。
取消、坏包和写入失败不把临时内容当成成功。
全部发布记录保存在本地 `.sync-revisions/records/`，供后处理确认修订链。
应用私有状态另存已应用摘要；本地 records 也约束云端历史，迁移应用配置后仍能检测历史缺失。
旧包和记录不自动过期；本地损坏文件也按实际摘要留档。
旧版下载器遗留的 gzip 记录先有界解压并与云端记录核对；内容一致后恢复普通 JSON，
内容冲突仍停止，不能把解压成功当作历史一致。

## 维护发布

`scripts/publish-revision.cjs` 复用既有 GUI 登录，启动独立的本机维护服务。
默认只预检；显式 `--publish` 才写入。仅本次临时维护服务开启 WebDAV 写权限，
不修改正常同步服务或云端账号授权，不提供删除操作。

```powershell
electron scripts/publish-revision.cjs --job SUBSCRIPTION_ID --record revision.json --package revised.zip
electron scripts/publish-revision.cjs --job SUBSCRIPTION_ID --record revision.json --package revised.zip --publish
```

预检下载原件核对完整 SHA256。发布先上传新对象和同名暂存包，回读校验后移动原包到回收目录，
新包移到原路径，最后提交并回读记录。中断后用相同记录和包重试，保留已上传/回收的内容。
源文件或不可变对象冲突时停止，不能强行覆盖另一份内容。

批量维护使用 `--batch batch.json --workers 4 --journal published.jsonl`；批次格式为
`{"schema_version":1,"items":[{"record":"绝对路径/revision.json","package":"绝对路径/revised.zip"}]}`。
每个原路径只出现一次，并发限制为 1～4；成功逐条写入日志，失败项保留错误，可用同一批次重试。
同一编号的记录和对象保持不可变；原包移动后中断也能续接，不需要先删除任何文件。

如果环境代理使对象上传持续超时，维护命令可加 `--direct-upload`，仅在该进程为
夸克/UC API 和阿里云对象域名追加 NO_PROXY，不改变系统代理或 GUI 设置。
下载固定要求原始字节，防止 CDN gzip 响应与 WebDAV 原文件长度不一致。

`--native-upload` 使用维护用的夸克分片上传实现，显示分片进度、发送准确 Content-Length，
单次对象请求无响应超过 30 秒即停止，含连接阶段最多 60 秒，分片最多重试三次。协议依据
[OpenList quark_uc 实现](https://github.com/OpenListTeam/OpenList/blob/v4.2.6/drivers/quark_uc/driver.go)，
仍由原发布流程回读完整 SHA256 并保留原件。默认 WebDAV 上传设置八分钟硬截止；
“秒传完成”但目录尚不可见时会短暂等待，已可见却摘要错误的内容立即拒绝。
夸克分片接口实测要求顺序上传（乱序返回 `PartNotSequential`），仅在不同文件之间并发。
成功响应丢失后，重传可能返回 `409 PartAlreadyExist`。维护上传器读取该上传任务的
已存分片，核对编号、长度和本地分片 MD5 后继续；缺失或内容冲突立即停止。
分片恢复不替代发布前的整包 SHA256 回读，回收和同名替换仍在整包校验之后。

维护验收可运行 `electron scripts/apply-revisions.cjs --job SUBSCRIPTION_ID --verify-repeat`，
仅同步已发布的修订并检查重复执行零更新。持续自动检查仍需在新版 GUI 对该订阅开启修订同步。

测试覆盖修订链、取消、损坏、并发本地编辑、原包回收、中断重试、真实 OpenList/rclone 下载。
