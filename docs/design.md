# bun-reader 设计文档

> 定位：借鉴 Legado（阅读）的多用户 Web 阅读器，PWA 形态，书源引擎为核心价值。
> 本文汇总全部设计规范（总体设计 / 规则语法 / 脚本引擎 / 阅读器 UI），改动需求直接更新对应章节，不按日期分文件。

## 目录

- [一、总体设计](#一总体设计)
- [二、书源规则语法 v2（链式调用）](#二书源规则语法-v2链式调用)
- [三、书源脚本引擎（M2 v2）](#三书源脚本引擎m2-v2)
- [四、阅读器 UI 设计](#四阅读器-ui-设计)

---

# 一、总体设计

## 1. 需求画像

- **部署形态**：自部署多人系统，支持登录注册（几个熟人共用，非公开多租户）
- **核心价值**：兼容 Legado 书源生态（JSON 格式直接导入），服务端抓取在线书站
- **目标设备**：手机 PWA 为主 + 桌面浏览器均衡适配
- **首版功能**：核心阅读链路 + TTS 朗读 + 书源调试工具 + 阅读器内刷新
- **明确不做**：漫画/RSS、换源、净化规则管理、WebDAV、JS 脚本书源、仿真翻页动画、邮件找回密码（注：换源、JS 脚本源后已实现，见第三、四部分）

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Bun 单进程 | Bun.serve 一进程包揽静态资源 + API + SSE |
| 后端框架 | Hono | 轻量、类型好、Bun 一等公民 |
| 数据库 | SQLite (bun:sqlite) + Drizzle ORM | 原生同步 API 性能强；drizzle-kit 管迁移 |
| 正文存储 | 磁盘 txt 文件 | 见 §4 |
| 前端 | React 18 + Vite + Tailwind CSS | 生态成熟 |
| PWA | vite-plugin-pwa (Workbox) | App Shell 预缓存 + 章节运行时缓存 |
| TTS | 浏览器 SpeechSynthesis | 服务端零成本 |
| 规则解析 | cheerio | 替代 JSoup，翻译 Legado 选择器语法 |

**架构决策**：书源规则解析在服务端执行（绕开 CORS），顺带实现正文缓存与共享。

```
┌───────────────────────────────────────────┐
│            Bun 进程 (:8094)               │
│  Hono 路由 ──┬── 静态资源 (React 构建产物)  │
│              ├── /api/*                   │
│              ├── /auth/*  (JWT Cookie)    │
│              └── 书源规则引擎 (cheerio)     │
│  bun:sqlite (book.db)                     │
│  data/cache/{sha1(book_url)}/{idx}.txt    │
│  定时任务: 书架更新检查 (setInterval)       │
└───────────────────────────────────────────┘
```

## 3. 认证与账号

- 用户名 + 密码（bcrypt），JWT 放 httpOnly Cookie，中间件统一校验
- API：`POST /auth/register`、`POST /auth/login`、`POST /auth/logout`、`GET /auth/me`
- 账号资料（设置页）：`PUT /auth/profile`（nickname ≤20 字；avatar 为 dataURL，≤300KB，仅 png/jpeg/webp）、`PUT /auth/password`（验旧密码，新密码 ≥6 位，成功后保持会话）
- 头像存储：**前端 canvas 压缩成 128×128 JPEG dataURL 直接入库**（users.avatar），不起文件服务；无头像时前端用昵称/用户名首字画圆
- 不做邮箱验证、找回密码

## 4. 数据模型

SQLite 表 + 磁盘文件：

| 表 | 字段 | 说明 |
|---|---|---|
| `users` | id, username, password_hash, nickname, avatar, created_at | 多用户；nickname/avatar 为可选资料（avatar=128px dataURL） |
| `sources` | id, name, enabled, "group", json, type, code, last_use_at | **全局共享**；json 存源定义（rules=规则原文 / script=表单数据），code 存生成脚本 |
| `rate_states` | source_id, cap, high, window_ms, last_fail_at | 缓存自适应限速频率（按书源持久化） |
| `books` | id, book_url, source_id, name, author, cover, intro, latest_chapter, last_check_at, updated_at | **全局共享**（预览即入库）：唯一约束 (book_url, source_id)，同一本书全站一行；updated_at = 最近「发现新章节」时间（书架「最近更新」排序） |
| `shelf` | user_id, book_id, created_at | 书架 = 用户↔书籍关联；**加书架只插这一行**，created_at 即「加入书架时间」（书架按它排序） |
| `chapters` | id, book_id, idx, title, url | 目录快照，入库时后台抓取，按需刷新 |
| `chapter_cache` | content_key(sha1(book_url)), idx, file_path, size, is_placeholder, fetched_at | 正文索引；文件在 `data/cache/` |
| `cache_jobs` | content_key, total, done, failed, status, updated_at | 全本缓存后台任务进度（多用户共享） |
| `progress` | user_id, book_id, chapter_idx, scroll_pos, updated_at | 主键 (user_id, book_id)：书共享，进度各人一份 |
| `settings` | user_id, key, value | 阅读偏好 |

**建表与加列**：`db.ts` 启动时 `CREATE TABLE IF NOT EXISTS` 幂等建表，**表结构以 CREATE 语句为唯一事实来源**——加列直接改 CREATE；存量库靠 `PRAGMA user_version` 标记的迁移块推进（目前 v1：books 去掉 user_id 全局化 + 新增 shelf + progress 主键改 (user_id, book_id)；按 (book_url, source_id) 合并重复书籍，然后把旧行里的书架/进度迁过去，全程一个事务，`foreign_keys` 临时关闭）。

**预览即入库（为什么 books 不带 user_id）**：搜索/探索/调试页点开一本书，先把 books + 目录写进库再进详情页，于是详情页同时也是「预览页」——未收藏时按钮显示「＋ 加入书架」，收藏后变「移出书架」。代价是库里会堆很多只看过一次的书，所以有**每日清理**（见 §9 定时任务）：删除「没有任何 shelf 引用」且入库超过 24h 的书，连同 chapters / progress / 正文缓存 / cache_jobs 一起回收，并顺手清掉「没有书引用」的缓存目录（换源后的旧地址残留）。宽限期与周期都可用 `CLEANUP_GRACE_MS` / `CLEANUP_INTERVAL_MS` 调（置 0 关闭）。

**换源语义**：`PUT /books/:id/source` 是**原地改这一行**的 source_id + book_url 再重抓目录，书架关联、阅读进度、书籍 id 全部不变（阅读器换源后不用跳转，进度按章节序号延续）。若目标 (book_url, source_id) 已经被别人预览入库，会先把那本书的 shelf / progress 合并到当前书上再删掉它，避免撞 `books_url_src` 唯一索引。注意：换源后 `contentKey = sha1(newBookUrl)` 变了，旧源的正文缓存成为孤儿，由每日清理回收（新源若已有缓存则直接复用）。

**正文落盘**：`data/cache/{sha1(book_url)}/{idx}.txt`。库只存元数据；同一本书不同用户天然共享缓存；清理即删目录。服务端以异步文件 I/O 读写正文，避免大文件操作阻塞请求处理。

**缓存任务恢复**：全本缓存任务只在当前服务进程内运行。服务启动时，残留的 `running` 状态会改为 `stopped`，避免 UI 显示一个实际已中断的任务仍在运行。

**疑似占位章节判定**（双重规则，命中任一即标记）：

1. 正文字数 < 阈值（默认 50 字，可在设置中调整）
2. 正文命中占位关键词：内置默认词表（"更新中"、"稍后更新"、"章节内容稍后"、"审核中"、"暂未更新"、"购买后查看" 等），词表存 settings 表**可自行增删**

标记为疑似占位的章节：缓存照常落盘，阅读器刷新按钮提示"本章疑似占位内容，可尝试刷新获取最新"。

## 5. API 概要

- **书源**：`GET/POST/DELETE /sources`（URL 批量导入 / 粘贴 JSON / 文件上传；列表额外返回 `bookCount` = 该源下书籍数，按 `bookUrl` 去重）、`POST /sources/:id/test`（体检）、`POST /sources/:id/debug`（SSE 调试日志，`{bookUrl}` 调书籍 / `{mode:"search",key}` 调搜索）
  - **脚本源保存**：`POST /sources/script`（新建）、`PUT /sources/script/:id`（更新）。`PUT` **允许把已有的规则源就地切成脚本源**（`type` 改 `script`、`json` 换成脚本表单、`code` 重新生成），**id 不变**——书籍/书架按 `source_id` 引用，改类型不会连带失效；规则 JSON 会被脚本表单覆盖（要留规则请先导出）。返回 `{ok, id, converted}`，`converted=true` 表示这次发生了类型切换。典型场景：WAF 站点（如 69shuba）规则源的普通 fetch 恒 403，只能整源改成走浏览器的脚本源
- **搜索**：`GET /search?q=` — 并发扇出全部启用源（每源并发 1、间隔 300ms、总超时 15s），**SSE 流式返回**；前端按书名+作者聚合去重，并可查看逐源失败原因
- **书架**：`GET /books`（join shelf，`createdAt` 取加入书架时间）、`POST /books/import`（**预览即入库**：按 (bookUrl, sourceId) 幂等写 books，目录后台补；`onShelf:true` 顺带加书架；返回 id 供前端直接进详情）、`POST /books/:id/shelf`（加入书架）、`DELETE /books/:id/shelf`（移出书架，书与缓存保留）、`GET /books/:id` 返回书籍详情 + `onShelf` 并**联表带出 `sourceName`**
- **读接口不再按用户过滤**：books 全局共享，未加入书架也能看详情/目录/正文/缓存；只有 `GET /books`（书架列表）和 `progress` 是用户维度的
- **目录**：`GET /books/:id/category`（`?refresh=1` 强制刷新）
- **正文**：`GET /books/:id/content/:idx`（`?refresh=1` 绕过缓存重抓）
- **进度**：`PUT /books/:id/progress`
- **缓存**：`POST /books/:id/cache-all`（全本后台缓存）、停止/释放接口

## 6. 书源规则引擎

**书源 JSON 格式完全兼容 Legado**；引擎内部将 Legado 选择器语法翻译为 cheerio 调用（语法规范见第二部分）。

抓取管线：构造模板 URL（`{{key}}`）→ fetch（书源 headers 优先，默认浏览器 UA/Referer）→ 编码识别（GBK/GB2312 用 iconv-lite，默认 UTF-8）→ 规则提取 → 正文正则净化 → 落盘。

限流：搜索每源串行 + 300ms 间隔，超时取 `httpText` 默认 20s，失败不阻塞其他源。

**探索（分类浏览）**：书源 `exploreUrl` 每行一个分类，`parseExploreGroups` 解析「标题::模板」（Legado 标准）、旧式「标题,http…」（后段以 `http(s)://` 或 `/` 开头才算分隔，避免切到模板自带的 `,{json 选项}`）与裸模板行（标题自动编号）；`<js>`/`@js:` 生成的静态解析不了，视为无分类。`exploreSource(src, tpl, page)` 复用 `buildReq`（替换 `{{page}}` + 请求选项）与搜索同一套 bookList 映射（`mapBooks`，搜索/探索共用）；规则缺省 `ruleExplore` 回退 `ruleSearch`（同 Legado）。页码 clamp 1..200。脚本源暂不支持探索。**探索源清单不做过滤**：所有启用的源都返回，没配 exploreUrl 的由前端提示去「分类」区块补（以前按「解析出分类」过滤，新加的源直接消失，看起来像没保存成功）。

**抓取层容错（`fetcher.ts`）**——站点换域名导致「搜索 500、详情正常」的根治点：

- 换域名站点的 301 Location 常写成「绝对路径、不带查询串」（实测 `www.sudugu.org → www.shudugu.org → www.suduguu.com`，`/i/sor.aspx` 的 `?key=` 全丢），跟随重定向后落到新域名的空参数页，ASP.NET 直接 500；而详情/目录靠 path 不靠 query，重定向后照样能开——这就是「详情调试没问题，就搜索报错」的成因。
- 兜底规则（仅下列条件全中才触发一次重试）：请求是 GET 且无 body、原 URL 带 `?`、**最终 URL 的 host 与原来不同**、最终 URL 没有查询串、且最终响应 ≥400 → 用「最终域名 + 原查询串」重发一次；重试结果更差就返回原始错误。同域名重定向（多为 URL 规范化）不猜，POST 不猜。
- 命中时 `log.warn("fetch", ...)` 一行，调试面板可见。
- HTTP 报错统一带最终 URL（`HTTP 500 · utf-8 · https://www.suduguu.com/i/sor.aspx`）：请求 URL 与落地 URL 不一致时，少了它就只剩一句「HTTP 500」，无从下手。

**超时与「200 + 0 字节」（`fetcher.ts`）**——IIS/ASP.NET 站限流的典型表现，不识别就会误判成书源规则写错：

- **默认超时 20s**（原 10s）。慢站单页就要 15s+（实测肉色屋：详情 15s、目录页 17s、偶发 60s），10s 必然超时；目录页另给 25s（`TOC_TIMEOUT`，页面更大又常被限速）。
- **超时错误带人话**：`请求超时（上限 20s，已等 20.0s）：<url>`。`AbortError` 原本的 message 是 `The operation was aborted.`，谁也看不出等了多久、卡在哪个 URL。
- **200 + 空 body 当失败重试**（最多 2 次，间隔 0.8s/1.6s）。站点限流时返回的不是 404 而是 `200 + Content-Length: 0`；不识别就会一路解析出 0 个元素，最后报「目录为空」——用户以为是规则配错，实际是被拦了。
- **目录页抓取另有 3 次重试**（`fetchTocPage`：超时 / 网络错误 / 空内容都算失败），第 1 页尤其不能一次就判死整本书。
- 详情页仍是空内容时抛 `详情页内容为空（HTTP 200，0 字节）：站点限流，或该书需登录/已下架`，不再把原因埋到「目录为空」里。

**目录抓取状态（`tocStates`，进程内）**——决定前端该不该继续等：

| 状态 | 含义 | 前端行为 |
|---|---|---|
| `fetching` | 后台 `fillToc` 正在抓 | 轮询（间隔 1.5s→3s→5s→8s→10s 封顶，最长 5 分钟） |
| `done` | 目录已就绪 | 停止轮询 |
| `failed` | 抓取失败，带 `error` 原文 | **立即停止**，显示原因 + 「重试抓目录」按钮 |
| `idle` | 目录为空但没有任务（进程重启过） | 不轮询，显示「抓取目录」按钮 |

- `/category` 与 `POST /import` 都返回 `toc: {status, error}`；`PUT /:id/refresh`（手工重试）失败时返回 **502 + 可读 error**，不再抛 500。
- 前端轮询是**串行**的（一次返回才发下一次）。原来是 `setInterval` 固定 2s：接口一慢请求就堆积、后台早失败页面还在打满 2 分钟、刷新页面又开一轮——「一直在发请求、重启也停不下来」就是这么来的。
- 后台任务日志接进服务日志（`[toc] 第 2 页请求失败（请求超时…），重试 1/2`），排查时能看到卡在哪一页；原来 `fillToc` 不传 log，只剩一句「目录抓取失败」。

## 7. 前端页面

| 路由 | 页面 | 要点 |
|---|---|---|
| `/` | 书架 | 手机 3 列网格 / 桌面列表；排序 tab（默认「最近阅读」，可切「最近更新」）。**右上角账号区**：未登录=登录按钮；已登录=头像圆钮（无头像显示首字）→ 下拉（昵称 / 设置 / 退出登录）。**移出书架 = 右键或长按 500ms**（移动端没有右键），长按触发后吞掉同一次 click 不进详情。列表有**加载中状态**（转圈 + 「书架加载中…」），请求未回不显示「空书架」 |
| `/search` | 搜索 | SSE 实时追加结果卡片，聚合去重；搜索进度随新一轮搜索重置，失败书源及错误原因可展开查看。布局：`← 书架` 在左，输入框中间（**16px 字号防 iOS 聚焦缩放**，框内有 × 清空），搜索按钮在右。登录/设置页输入框同为 16px |
| `/explore` | 探索（分类浏览） | **上下结构 + `flex h-dvh flex-col`**：顶部**两行**——①`← 书架`（+ 页面标题）独占一行 ②书源 select（`text-base`，同 16px 规则，`max-w-40 flex-none`）+ 分类按钮（`flex-1 overflow-x-auto no-scrollbar` 单行横向滚动、**隐藏滚动条**，按钮 `flex-none`，选中 amber）；列表区 `min-h-0 flex-1 overflow-y-auto`（**flex 子元素滚动必须 `min-h-0`**），换源/换分类/换页自动回顶；底部翻页条（上一页/第 N 页/下一页）。下一页可用性看本页结果（空页=到底，显「没有更多了」）。点卡片 = `POST /api/books/import` 入库后直接进 `/book/:id`（不再是独立的预览页）。后端 `GET /api/sources/explore`（**全部启用的源**，含还没配分类的新源——前端显示「还没有探索分类」并指引去编辑书源 →「分类」；脚本源 categories 恒为空、提示不支持）与 `GET /api/sources/:id/explore?url=分类模板&page=N`；模板原样透传给引擎替换 `{{page}}`。默认选中的是**第一个配了分类的源** |
| `/book/:id` | 书籍详情（兼预览） | **预览与详情共用这一个页面**：进页面时书与目录已在库中（来源：搜索/探索/调试页入库），只是用户还没加入书架。封面左（垂直居中）、信息右；**操作按钮一排在卡片下方**：开始阅读/继续阅读（主按钮，按内容定宽、不 `flex-1` 拉满）、**加入书架 ⇄ 移出书架**（`onShelf` 切换；移出后停留在本页不跳走）、检查更新、编辑，**全部左对齐**；**缓存一排紧跟其后**：左侧「书源：xxx」（源被删显示「无（源已删除）」，只有 id 时显示 `#id`），右侧缓存信息 + 缓存全本/停止/释放。**整页定高 `flex h-dvh flex-col overflow-hidden`**：头部信息/按钮/缓存 `flex-none`，目录区 `flex min-h-0 flex-1 flex-col`——列表 `min-h-0 flex-1 overflow-y-auto no-scrollbar`（**目录自己滚、隐藏滚动条**，翻页/切排序回顶），**分页条 `flex-none` 贴底不跟着滚**。目录**分页每页 100 章**（正/倒序先排序再切片，首次载入定位到「上次读到」所在页），**页码是 select 可直接跳到最后一页**，目录有加载中状态 |
| `/preview` | 兼容旧链接 | 旧入口 `/preview?sourceId=&bookUrl=` 只做「入库 → `replace` 跳 `/book/:id`」，不再有独立预览界面 |
| `/book/:id/read/:idx` | 阅读器 | 见第四部分 |
| `/settings` | 账号设置 | 头像（点击圆形选图，本地压缩预览，随「保存资料」提交）、昵称、修改密码（旧密码 + 新密码×2）；保存后通知 App 刷新 `/auth/me`，书架头像立即生效 |
| `/sources` | 书源列表 | 书架点「书源」的落地页。顶栏：**左=返回书架 icon，右=新建**；列表每行 = 源名称 + **分组角标**（`sources.group`，导入的 Legado 源自带 `bookSourceGroup`，常见「自制」「网络文学」；自建源默认「默认」——**一律显示**，不再「非默认才显示」） + 「脚本」/「停用」角标 + 该源书籍数（`bookCount`，按 `books.book_url` 去重计）+ 调试 icon + 删除 icon。点行进出编辑页，点调试 icon 进编辑页并直接落在调试 tab。筛选与导入/导出 URL 也在此页 |
| `/sources/new`、`/sources/:id` | 书源编辑/调试 | **同一页面按 URL 区分**：无 id（`/sources/new`）= 新建（顶栏给「规则源 / 脚本源」类型切换），有 id = 载入该源；`?tab=debug` 直接打开调试 tab（列表的调试入口就带这个参数）。**新建保存成功后 `history.replaceState` 把 URL 换成 `/sources/:id`**（只替换路径尾段，保留 `/reader` 部署前缀；不进历史，刷新后能直达该源）。返回列表时有未保存改动会先确认。**左栏规则源表单按区块折叠**：基本/搜索/**分类**/详情/目录/正文 各区块是折叠面板（缺省展开），点标题行收放——箭头旋转 + 内容高度 200ms 过渡（grid-rows 0fr↔1fr），表单值不因收起丢失。**「分类」区块位于搜索与详情之间**：`exploreUrl`（每行 `分类名::分类地址`，可含 `{{page}}`，填了才会出现在探索页）+ `ruleExplore.*`（列表/书名/作者/封面/详情地址，留空复用搜索规则）。脚本源表单的「基本」里有**源分组**字段（以前硬编码 `group="脚本"`） |

### 危险操作确认（统一弹层）

删除/移出/释放这类不可逆操作**一律先确认再执行**，用 `web/src/Confirm.tsx` 的 `useConfirm()`（`const [ask, ui] = useConfirm()` → `await ask({title, desc, okText})`）：弹层为深色卡片 + 半透明遮罩，确认键默认红色（`danger:false` 时琥珀色，用于换源这类非破坏动作），点遮罩等同取消。

- **不用 `window.confirm`**：iOS PWA / 内嵌 WebView 里样式不可控，个别浏览器会静默吞掉，「点了没反应但已经删了」是最不能接受的失败方式。
- `desc` 必须写清**影响范围与能否恢复**（例：释放缓存要说明章数 + 同书所有用户共享；删除书源要说明书架里的书保留、但之后无法再从该源更新）。
- 覆盖点：书架长按/右键移出、详情页释放缓存与移出书架、书源删除、阅读器换源、书源编辑页带脏数据返回列表。

### 调试面板（书源页右侧）

调搜索与调书籍都走**同一条 SSE 流**（`POST /sources/:id/debug`），日志边跑边到，绝不攒到最后一次性返回：

| 事件 | 含义 | 前端处理 |
|---|---|---|
| `{level,step,msg}` | 引擎/底层日志行 | 追加到日志区（info/ok/warn/err/text 五色，`text` 为正文原文行） |
| `{step:"books",books}` | 搜索书单 | 渲染结果卡片（封面+书名+作者+最新章，书 URL 可点填入「调书籍」） |
| `{step:"bookinfo",info}` | 详情解析结果 | **详情一解析完就推**（不等目录正文），渲染书籍卡片：封面 / 书名 / 作者 / 最新章 / 简介；字段取不到时显式标「未取到」并提示对应规则名，避免只看到下游的「佚名」 |
| `{step:"chapter",msg}` + 逐行 `{level:"text",step:"正文"}` | 首章正文全文 | 调试跑完目录后，先报「首章《x》正文全文 · N 段」+ 首章地址，再把正文**按段落逐条**推进流里（空行显示 `·（空行）`，首尾有 `────── 正文开始/结束 ──────` 分隔）；正文行不打 `[step]` 前缀，读起来就是一篇文章。只看字数无法判断段落是否被压成一行、广告/拼音残留在哪 |
| `{tick:秒}` | 3s 无事件时的心跳 | 日志区尾部显示「运行中 · Ns」，让人知道没卡死 |

三个保证实时性的手段：

1. 引擎自身的 `log` 回调逐步骤 push；
2. 底层日志（浏览器启动、人机验证等待、脚本源 `log()`）经 `runWithLogSink`（AsyncLocalStorage）实时并入同一条流——此前只落盘，调试面板看不到，于是"浏览器启动 30s"表现为长时间空白；
3. `X-Accel-Buffering: no` + `no-transform`：nginx 等反代默认缓冲响应体会把 SSE 攒成一坨。

「以详情解析结果为准」：书籍卡片上的作者/封面来自 `ruleBookInfo`（规则源）或 `getDetail` 返回值（脚本源），字段为空即规则没命中，卡片会用琥珀色标出「未取到」而不是回退成「佚名」——佚名是入库时的兜底展示，不该用来判断规则好坏。

## 8. 错误处理

- 搜索：单源失败静默跳过，底部汇总"已完成 x/y（n 失败）"
- 正文失败：阅读器内联重试卡片，不白屏
- 后台任务：逐章 try/catch + 重试退避，日志落 `data/logs/日期.log`

## 9. 部署与缓存（Cloudflare CDN → NAS nginx → Bun）

- 链路：jiayou.work（Cloudflare CDN）多应用共用域名按路径转发（/reader、/hentai、/manager…）→ NAS nginx（**/reader 静态文件由 nginx 直接服务**，API 反代到 Bun:8094）。
- **缓存头必须在 nginx 里配**（静态文件不过 Bun）；后端 `cacheStatic`/`noStore`（src/index.ts）对反代接口与兜底场景生效。
- 分层策略（三层缓存：Cloudflare 边缘 / 浏览器 / SW precache）：
  - `/reader/assets/*`（文件名含内容 hash）：`public, max-age=31536000, immutable`——内容变了文件名必变，可长期缓存；
  - `index.html` / `sw.js` / `manifest.webmanifest` / `registerSW.js` / `workbox-*.js` / `icon.svg`：**`no-cache`**——每次导航回源校验。**SW 更新检测依赖每次拿到最新 sw.js**，若 sw.js 被边缘/浏览器缓存旧版，PWA 永远停在旧版本（症状：build 后刷新多少次都不更新，index.html 一直是 SW precache 里的旧页）；
  - `/api/*`、`/auth/*`（含 /gw/reader 别名）：`no-store`。
- nginx 参考配置（用 `root` 指到 `web/`，URI /reader/x 直接映射 web/reader/x；**别用 alias + 嵌套正则 location**，正则 location 不继承 alias）：

```nginx
location /reader/ {
    root /path/to/bun-reader/web;          # /reader/xx → web/reader/xx
    index index.html;
    try_files $uri $uri/ /reader/index.html;

    # 带内容 hash 的产物：长缓存
    location ~ ^/reader/assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
    # SW 与入口文档：任何缓存层都不许钉死旧版
    location ~ ^/reader/(sw\.js|registerSW\.js|workbox-.*\.js|manifest\.webmanifest|icon\.svg)$ {
        add_header Cache-Control "no-cache" always;
    }
    location = /reader/index.html {
        add_header Cache-Control "no-cache" always;
    }
}
```

- **Cloudflare 默认按扩展名缓存 js/css（sw.js 命中 .js）**：origin 有 no-cache 后 CF 尊重并不再缓存边缘副本；但已缓存的旧 sw.js 必须在 CF **清一次缓存**（至少清 `https://jiayou.work/reader/sw.js`）才会消失。验证：`curl -sI https://jiayou.work/reader/sw.js | grep -i cache-control` 应返回 no-cache。
- PWA 更新链路：sw.js 生成配置含 `skipWaiting + clientsClaim`；前端 `registerSW({ immediate: true })` 在新 SW 激活（isUpdate）时自动 `location.reload()`。正常发版流程：第一次刷新仍是旧版（同时后台检测并安装新 SW），安装激活后自动 reload 进新版。
- API 反代保持 `proxy_buffering off`（SSE 调试流实时性，配合后端 `X-Accel-Buffering: no`），并加 `proxy_read_timeout 600s`（目录翻页长请求）。

---

# 二、书源规则语法 v2（链式调用）

## 目标语法

规则 = `[CSS选择器][.链式调用...]`，**去掉 @ 分节器**。

- 选择器：cheerio 支持的 CSS —— `'#id'` `'.class'` `'div.main div.content'`，`:eq(2)`（cheerio 原生伪类，直接透传）
- **选择器建议用引号包裹**：`'h1'.text()`、`'.bookname a'.attr('href')`——引号只是把选择器括起来；裸写 `h1.text()` 同样有效
- 取值：`.xxx(...)` 函数调用风格，永远在规则末尾：
  - `'h1'.text()` → 引擎处理为 `$('h1').text()`
  - 章节地址：`'a'.attr('href')`，或列表项已是元素时直接 `.attr('href')`
  - 深层取值：`.find('a').attr('href')`
- `:eq(N)` 语义：整个结果集的第 N 个（≡ `.eq(N)`，`.eq(n)` 方法保留；cheerio 1.2 实测单/多容器一致）
- 链式调用清单：取值 `text/html/all/ownText/textNodes/textBlocks/attr('x')`；导航 `find('sel')/children/eq(n)/first/last/parent/next/prev`；后处理 `trim()`
- **`.trim()` 后处理**：跟在 `.text()` / `.textBlocks()` / `.attr()` 等取值调用后面。无参 = 去两端空白；`.trim('字面量')` = 再去两端该字面量，用于处理「简介：」「作者：」这类标签前缀（`'.intro'.text().trim('简介：')`）。只作用于字符串值，元素节点原样放行
- **导航链压缩（legadoToOurs 自动做，幂等）**：`.find('x')` 并进选择器用空格相接、`.eq(n)/.first()/.last()` 并成 `:eq(n)`（0/-1），整段引号包裹——`p.eq(1).find('a').text()` → `'p:eq(1) a'.text()`；`.itemtxt.find('p').eq(1).find('a').text()` → `'.itemtxt p:eq(1) a'.text()`。`children/parent/next/prev` 与取值/后处理调用不能并进选择器，断开后原样保留在链上；相对链开头的 `.eq/.first/.last`（无选择器、作用在输入集本身）保持调用形态不压缩。**可靠性依据**：`:eq(N)` 与 `.eq(N)` 同为结果集全局索引，且引擎按项求值（单节点上下文），此时 find+eq 与选择器内 `:eq` 严格等价
- **正文规则只写选择器**（推荐写法）：`ruleContent.content = '.articlebody'` 就够，引擎先用选择器选到节点，再做**结构清洗**（删 `script/style/ins/…`、删隐藏节点、删「只含链接的短块」、独立短链接 `<a>` 整块删、夹在散文里的 `<a>` 解包保留文字），最后按块分段——也就是 `contentRule()` 自动补的那一个 `.textBlocks()`。实现：规则的 `||` 每一段、`##` 后处理之前，若链上没有任何取值调用（`text/textNodes/textBlocks/ownText/html/all/attr/trim`）就补 `.textBlocks()`；显式写了取值调用的原样生效，存量源零改动（`src/source/rule.ts` 的 `contentRule()`，规则源引擎与脚本源 `ruleContent()` 共用）。**强制要求用户记 `.textBlocks()` 是个坑**：漏写就静默退化成一行文本，整章没段落，排查时极难看出是规则少了尾巴
- **`.textBlocks()`**：正文段落提取——取最内层块级元素文本（嵌套 p 去重）、`<br>` 视为换行、容器裸文本（广告行）跳过、按文档序 `\n` 连接；容器内**没有块级子元素**（整段正文只用 `<br/>` 分行 + `&nbsp;` 缩进的手机站，如肉书屋）时回退为容器自身文本。默认还做上面那套**容器级清洗**，`ruleContent.stripTags=false` 可关（个别站点正文就藏在隐藏节点里）。正文规则**不要用 `.text()`**（全部拼一行无换行，且不做容器清洗）
- **额外删标签 `ruleContent.dropTags`（源级开关，不进规则语法）**：逗号/空格分隔，`span,font,section`。默认删除清单是 `script,style,iframe,noscript,template,object,embed,svg,canvas,video,audio,source,track,ins`——**`span` 默认必须保留**：正文常整段包在 span 里（字体加密、字数统计、高亮），按标签删会把字一起删掉。所以「某站用 span / font 包广告」这类需求走 `dropTags`，语义是**删标签连同内容**。三条边界：
  - **只作用于正文**。标题/简介/目录用 `.text()` 取，不受影响；`dropTags` 只进 `textBlocks()` 的清洗路径（`EvalOpts.dropTags`）
  - **`stripTags=false` 时也不生效**（总开关优先），避免两个开关打架
  - **非法标签名静默忽略**：只收 `[a-z][a-z0-9-]*`，且已在默认清单里的自动去重。用户写 `</div>`、`#content` 这类会把选择器拼坏 → 整个清洗失效、正文结构全乱，这是最难排查的一类故障，宁可忽略
  - 为什么不做成规则里的 `.remove('span')`：选择器是「定位」，删标签是「策略」。混进规则链要同时改链式解析、`legadoToOurs` 兼容层和转换器生成逻辑，而收益只是少填一个输入框；表单字段还能被「脚本源 / 规则源 / 转换器」三条链路自然共享（脚本源对应 `dropTags` 成员，`ruleText/ruleContent` 自动从实例取）
- 保留：`||` 回退、`##正则##替换##变换`、`{{bookUrl}}/{{baseUrl}}` 模板、JsonPath（$ 开头）、目录 `{page}` 模板

### 正文净化管线（`src/source/clean.ts`）

正文净化的本质不是「一串正则」，而是**固定顺序的几段**。顺序错了结果就错，所以段序写死在代码里，不交给配置：

| # | 段 | 做什么 | 为什么必须在这个位置 |
|---|---|---|---|
| ① | DOM 结构清洗 | 删 `script/style/iframe/ins/svg/video…`；**正文容器内**再删 `[hidden]`、`display:none`、`visibility:hidden`，删「只含链接 + ≤12 字 + 无句末标点」的块，独占一块的短链接 `<a>` 整块删、夹在散文里的 `<a>` 解包保留文字 | 标签只能在 DOM 阶段删。等取成纯文本，`<script>` 里的 JS 已经混进正文了——cheerio 的 `.text()` 会把脚本源码原样拼进去（实测 `正文<script>var ad="广告"</script>` → `正文var ad="广告"`），后面再强的正则也只能删残渣 |
| ② | 文本抽取 | 正文一律按块分段（内容规则只写选择器时由 `contentRule()` 补 `.textBlocks()`，块级分段 + `<br>` 换行） | `.text()` 全拼一行、`.textNodes()` 只取直接文本节点，正文场景都不对 |
| ③ | 整行删除 `line:` / `line!:` | 命中即删整行，不留空行 | **必须早于行内删除**：行内先把「【广告】」删掉，整行的特征就没了，`line:广告` 再也匹配不上 |
| ④ | 行内删除/替换 `re:` | 正则替换，默认不区分大小写 | — |
| ⑤ | 词典替换 `map:` / `map?:` | 单次扫描、长词优先 | 必须晚于删除：否则广告里的拼音也会被「还原」，白造垃圾。单次扫描是为了避免 A→B 之后 B 又被 C 命中 |
| ⑥ | 规范化 | 零宽/方向控制符、字面量 `\n`、全角空格、行内空白、连续空行、首尾 | 前几步都会制造空行与多余空格 |
| ⑦ | 质检告警 | 删过头（<40%）、中文占比过低、残留 JS、汉字夹拼音 | 净化失败要看得见，而不是让用户读到乱码才来问 |

**规则语法**（字段 `ruleContent.replaceRegex` / class `replace`，一行一条，`//` 开头是注释）：

| 写法 | 含义 |
|---|---|
| `line:正则` | 整行命中即删（删行不留空行） |
| `line!:字面量` | 同上，按字面量匹配，不用写转义 |
| `re:正则##替换` | 行内删除/替换（`re:` 可省） |
| `正则##替换为` / `##正则##` / `裸正则` | 旧写法，语义完全不变（`##正则##` = 删除；无 `##` = 删除） |
| `map:原词=新词` | 词典替换 |
| `map?:原词=新词` | 低频保护：全章出现 ≥2 次才换 |

- 词表也可单独写在 `ruleContent.replaceMap`（一行一条 `原词=新词`，或对象）/ class `replaceMap`，与 `map:` 等价
- **默认不区分大小写**。站点常用大小写混淆规避过滤（正文里塞 `www.qUAnbEn-xIaosHuo.CoM`），净化类规则的意图几乎总是「把这段干掉」，区分大小写只会漏删。要严格区分时写 `(?-i)`
- **兼容 Java/Legado 的内联标志** `(?i)` `(?im)` `(?-i)`：JS 不认识这种前缀，直接 `new RegExp("(?i)…")` 抛 `Invalid group`，以前被 catch 吞掉 —— 规则配了却毫无效果且没有任何提示。现在剥成真正的 flags，只映射 `i/m/s`（`u` 不映射：JS 的 `u` 会收紧转义，反而让 Java 写法的正则报错）
- **拼音与反义词不做自动还原**。这两类是信息丢失，不是编码问题：`de` 可能是的/得/地/德，`高兴↔难过` 无法判定原文哪一边。引擎只提供 `map:` 显式词表（人工维护）+「汉字夹拼音」「中文占比过低」告警，由人核对。`map?` 的低频保护是有依据的启发式：站点批量污染必然高频，正常用词低频
- **坏正则不再静默**：编译失败进 `warnings`（`N 条规则正则非法已跳过：…`），随日志输出
- **命中统计**：每章日志输出「净化命中 x/y 条：规则×次数」。0 命中的规则不报警（只对某些章有效），但保留在 `hits` 里，供规则预览面板使用
- **整章一次净化**：翻页循环只负责拼接原文，合并后净化一次。分页边界上的「本章未完，请点击下一页」「接上页」只有整章合并后才删得掉（以前每页各净化一次，永远删不掉）
- **缓存存原文、读时净化**：`data/cache/{key}/{idx}.txt` 存未净化的整章原文，`GET /:id/content/:idx` 命中缓存后再按当前规则净化。改规则立即生效，不必整本重抓（`Engine.contentRaw` + `Engine.cleanText`）
- **编译缓存**：`compilePipeline` 按（规则原文 + 词表）缓存编译结果（上限 128 条），全本缓存 2000 章不会把同一条正则编译 2000 次
- **四条链路统一**：规则源正文（`engine.cleanForSource`）、脚本源正文（`script.polish`）、字段级 `##` 后处理（`rule.applyRule`，只走正则段）、规则源→脚本转换（`convert.replaceMember`：纯正则是 `{regex,replacement}` 数组；含 `line:/re:/map:` 前缀时输出多行原文，否则 `line:广告` 会被当成字面量正则而失效）
- **可关容器清洗**：`ruleContent.stripTags=false`（个别站点正文就藏在隐藏节点里）


### 章节内翻页（正文分页）

很多站点的正文一页放不下，末尾带「下一页」。`ruleContent.nextContentUrl` 处理，两种形态：

| 形态 | 规则写法 | 引擎行为 |
|---|---|---|
| 下一页链接 | `'.bottem a:eq(3)'.attr('href')` 或 `'a:contains(下一页)'.attr('href')` | 逐页抓取后拼接；取到空即结束；地址已抓过则停（防环）；上限 50 页 |
| `{page}` 模板 | `{{bookUrl}}##_?\d*\.html$##_{page}.html` | 首次求值即识破为模板，之后**不依赖页内链接**，按页码 2,3,4… 直接展开 |

- `{{bookUrl}}` 在正文里的语义是**当前页地址**（`base` 传本页 URL，不是站点首页），所以模板建立在第 1 页 URL 上，`{page}` 从 **2** 起（第 1 页正文已在手）。适合「下一页」是 JS 按钮、末页链接被移除、但分页地址有规律（`xxx_2.html` / `?p=2`）的站点
- 模板 URL **不能过 `new URL()`**：`{}` 会被编码成 `%7Bpage%7D`，占位符就废了 → 只做「相对路径补 origin」
- **收口条件**：新页正文与上一页完全相同 → 判定站点对任意页码返回同一页，停止（模板盲试必须靠这条，否则同一段会拼满上限）；第 2 页起 HTTP 4xx/5xx 或正文规则未命中 → 保留已抓到的页，不整章报废；只有首页失败才抛错走重试

## 兼容迁移（normalizeSource，导入与运行前幂等转换）

旧语法 → 新语法：
- 裸取值器 `text/href/src/...` → `.text()` / `.attr('href')` / ...
- `a@text` → `'a'.text()`；`#info a.0@href` → `'#info a:eq(0)'.attr('href')`（导航链自动压缩进选择器，见上）
- `sel.N` 索引后缀 → `:eq(N)`（带数字类名如 `.item-2` 不误拆）
- `attr(x)` → `.attr(x)`；`tag(x)` → `x`；`children` → `.children()`
- Legado 关键字 class./tag./id. 照旧转换
- 已是新语法（末尾含方法调用，含 `.trim(...)`）的规则只做链压缩，不再当旧语法拆（幂等）

**header 统一对象化**：legado 的字符串 header 在导入/运行前解析为对象入库（宽松解析：标准 JSON 失败时截取首个平衡的 `{...}`，容错 devtools 复制片段）。本项目存储与运行期都不使用字符串形态。

---

# 三、书源脚本引擎（M2 v2）

## 0. 背景与目标

规则引擎（cheerio 选择器 + 链式取值 DSL）在调试反爬站点时暴露死穴：加密 AJAX、onclick base64 跳转、验证码等全靠引擎堆特例。改为 **JS 脚本书源**：每个源是一个 class，四个阶段方法（搜索/详情/目录/正文），特例逻辑归源，引擎只留沙箱、编排与通用净化。

## 1. 决策记录

| 决策点 | 结论 |
|---|---|
| 方法名 | `search` / `getDetail` / `getChapters` / `getContent`（全可选，缺 = 能力不支持） |
| 格式 | 单 JS 文本存 DB + 落盘 `data/sources/{id}.js`，`export default class Source` |
| 配置 | 类成员声明（`base`/`headers`/`replace`），引擎只读，**无构造器注入** |
| 翻页 | 引擎处理：`getChapters` 返回 `{list, next}` 引擎循环；`getContent` 可返回 `{text, next}` 引擎拼接；`next` 含 `{page}` 时引擎按页码展开（与规则源同规则） |
| 净化 | `replace` 成员 = `{regex, replacement}` 对象数组，引擎在正文合并后自动应用 |
| 执行 | 动态 import + 缓存（id+mtime 失效），Promise.race 超时；不做 Worker 隔离（源自用，半可信） |
| 旧规则源 | 编辑走规则表单，保存时**转换器生成 .js**，JS 不可手改 |
| 新 JS 源 | **表单制编辑**（见 §6），不提供裸代码编辑 |
| Playwright | 已实现（browser.ts，见 §8） |
| 字段命名 | camelCase：`detailUrl`/`tocUrl` |
| headers 形态 | 类成员 headers 恒为对象；字符串形态（规则源带过来）在生成/运行时自动解析 |

## 2. 脚本格式

```js
export default class Source {
  base = "https://yxshufang.com";            // 相对 URL 补全默认 base
  headers = { Cookie: "..." };               // 引擎注入到每次 fetchText
  replace = [                                // 正文净化，引擎在合并后统一应用
    { regex: "广告链接：.*", replacement: "" },
  ];

  async search(name, page = 1) {
    // 返回 [{ title, author?, desc?, cover?, detailUrl }]  detailUrl 必填
  }
  async getDetail(url) {
    // 返回 { title?, author?, desc?, cover?, tocUrl }  tocUrl 缺省 = url
  }
  async getChapters(url) {
    // 返回 { list: [{ title, url }], next? }  next 空/无 = 结束；翻页由引擎循环
  }
  async getContent(url) {
    // 返回 string（无翻页）或 { text, next? }（章节内部翻页，引擎拼接）
    // next 含 {page} 时视为分页模板（如 url.replace(/\.html$/, "_{page}.html")），引擎按页码展开
  }
}
```

- 四个方法全部可选：无 `search` → 不参与搜索聚合与换源候选；无 `getChapters`/`getContent` → 不能入库读书
- 错误：`throw new Error("原因")` 引擎捕获进日志；`log(msg)` 打调试日志
- 职责边界：广告剔除等站点特定清洗源自己做；行 trim、`\n` 归一、占位检测、字数校验引擎统一做

## 3. 引擎注入 API（源内可用）

```js
const res = await fetchText(url, { method?, headers?, body? });
// → { status, text, url }  url=重定向后最终地址
const $ = parse(res.text);   // cheerio load
abs("/book/1", res.url);     // 相对→绝对，base 参数缺省用源.base
log("调试信息");
// 规则兼容 helper（转换器生成的代码用）：
nodes(res.text); ruleText(ns, "'#article'.text()"); ruleSel(ns, "规则");
ruleContent(ns, "'#article'");  // 正文专用：只写选择器，自动清洗 + 按块分段
// 浏览器渲染（WAF/验证码/加密 AJAX 站点）：
const p = await browserOpen(url);   // 自动等 WAF 挑战/验证码人工通过
p.html(); p.click(sel); p.waitCount(sel, prev); p.waitForLoad(); p.close();
```

## 4. 执行流程

```
保存源 → sources 表落库（type/code/json）→ 写 data/sources/{id}.js
调用 → 动态 import（data:URL 直载，Windows 文件系统 import 有目录缓存竞态；mtime 失效）→ new Source() → 调方法
超时 → Promise.race 报错（目录抓取放宽 600s：多屏翻页 + 验证码人工验证最长 180s）
```

- **落盘文件是产物，`code` 列才是真相**：`data/sources` 不进版本库、部署机上常常不与数据库同步（被清空、换机器、只拷了 `book.db`）。所以：
  - **启动时自动生成**：`materializeScripts()` 扫 `type=script` 的源，文件不存在或头部不是相对路径 → 按数据库 `code` 重写；日志报「脚本源落盘重建 n/N」
  - **运行时自动生成**：`loadInst` 加载前先 `ensureScriptFile()`，缺文件就按传入的 `row.code`（没有则查库）生成，不重启也能自恢复
  - 不做「路径修复」：老文件里写死过 `file:///D:/projects/...`（搬到 Linux 变 `/D:/projects/...` → `Cannot find module`），一律按 `code` 重新生成，而不是改旧文件里的路径
- **脚手架里的 runtime 路径必须是相对的**：`data/sources/{id}.js` 头部由引擎生成一行 `import { ... } from "../../src/source/runtime.ts"`，**不写机器绝对路径**，`ensureScriptFile` 用这一行判断文件是否健康。
- 加载时把该说明符改写成本机 `pathToFileURL(runtime.ts)`：候选顺序 `BUN_READER_RUNTIME` 环境变量 → `import.meta.dir/runtime.ts` → `path.join(PROJECT_ROOT, "src/source/runtime.ts")`（`PROJECT_ROOT` = `src/source` 上两级）。
- data:URL 模块没有 base URL，**相对 import 无法解析**，所以只能改写成绝对 `file://` URL，不能让 Bun 自己解析相对路径。
- 孤儿文件（DB 里已没有这条源）不会被清理，重新生成只覆盖 DB 里仍存在的源。

## 5. 引擎接口

- `engineFor(row)` 按 `type` 分流：rules → 规则引擎；script → 脚本引擎，统一 Engine 接口 `{ search, bookInfo, toc, content, hasSearch }`
- 正文落地 `fetchAndSave`、全本缓存 `runCacheJob`、进度/换源全链路对引擎类型无感知
- **限速共享**：阅读触发抓取与全本缓存任务共用同源 RateLimiter（滑动窗口计频：成功数/60s 窗口、失败减半、high 不可触及、按书源持久化）

## 6. 编辑器 UI（表单制）

- **表单给人看和编辑，生成的 JS 才是给程序执行的产物**
- script 源表单：name/base/headers（JSON 对象文本）/replace + 四方法体（基础模板，留空 = 未实现）；保存时 formToCode 合并拼接为 class（validateScriptCode 先校验语法与 default 导出）
- script 源的 json 列存表单数据（编辑真相），code 列存生成产物；生成的 JS 只读预览
- 规则源保持规则表单编辑，保存时转换器自动生成脚本；存量源一律 type=rules，不做迁移

## 7. 规则 → JS 转换器（convert.ts）

| 规则制 | 生成的 JS |
|---|---|
| `searchUrl + {{key}}/{{page}}` | fetchText + 插值 |
| `ruleSearch/bookInfo/toc/content` 各字段 | parse + ruleText/ruleSel helper 调用 |
| `ruleToc.nextTocUrl` 翻页 | getChapters 内 while 循环 |
| `ruleToc` 的 `{page}` 模板 | while 循环展开 |
| `ruleContent.nextContentUrl` | getContent 返回 `{text, next}`（next 含 `{page}` 时由脚本引擎展开） |
| `replaceRegex` / `header` | class `replace` / `headers` 成员 |

测试断言：同 fixture 下生成脚本与规则引擎产出一致。

## 8. 浏览器抓取（browser.ts · 远程 KasmWeb chrome）

- **连接部署在 docker 的 `kasmweb/chrome`**（compose 见 `notes/docker/chromium-vnc`）：`chromium.connectOverCDP(CDP_URL)`，默认 `http://127.0.0.1:9222`（宿主 9222 → 容器 cdp-proxy 9223 → chrome 9222），`CDP_URL` 可覆盖。本地不再拉起 chromium
- **绝不能 `browser.close()`**：远程是共享常驻实例，close 会断开连接并清上下文（连接测试脚本已实测）；`closeBrowser()` 只关本进程打开的页、丢弃连接引用，远端 Chrome 不受影响；容器重启后 `getCtx` 检测 `isConnected` 自动重连
- **持久化 profile 在容器侧**（`./profile` 卷 → chrome user-data-dir）：cookie/localStorage 验证通过一次后续自动复用；人机验证可开 VNC 网页（`:6901`）在同一窗口手动完成
- **无 headed/headless 双模式**（旧设计已废弃）：远程唯一实例即真实 Chrome（实测 `navigator.webdriver=false`、UA 无 HeadlessChrome 标记，反自动化检测天然规避）；`browserOpen` 的 `headless` 参数仅为脚本 API 兼容保留
- WAF 判定（防误报）：标题命中（中文验证词 / captcha / waf / human verification）、「小页面(<4000) + 关键词」、或页面内嵌 Turnstile 特征（`challenges.cloudflare.com/turnstile` / `cf-turnstile` / `aegis_captcha_verify`）；挑战页轮询等待通过（30s 提示、180s 超时）
- **cookie 不能替代浏览器**：部分 WAF（如 69shuba aegis）同时校验 TLS 指纹，提取 cookie 给服务端 fetch 仍 403 → 这类站点必须全链路走浏览器（fetchText 会自动合并浏览器同域 cookie，可作普通 WAF 站的加速路径，但不保证够用）
- `BrowserPage.fetch(url, opts)`：页内上下文 fetch（page.evaluate），自动带浏览器 cookie / 真实 TLS 指纹，**支持 POST**（WAF 站搜索表单用）；`page.content()` 有「导航中」竞态（safeContent 重试兜底）

---

# 四、阅读器 UI 设计

## 1. 整体布局

- 阅读界面为**全屏 fixed 布局**，正文 `absolute inset-0` 铺满、内部滚动，**不随工具栏显隐移动**（避免阅读中内容跳动）。
- 所有工具栏/按钮/弹层均为**悬浮定位（absolute）**，盖在正文之上；显隐零位移。
- 正文常驻安全边距：手机 `pt-16 pb-24`，PC `pt-6 pb-16`，防止内容被顶栏/底栏遮挡。
- 断点：`>500px` 为 PC 布局（正文固定 640px 居中，菜单在两侧），否则手机布局（顶栏+底栏+两侧浮动按钮）。

## 2. 进度体系（两层，语义不同）

| 进度 | 含义 | 展示位置 | 是否同步后端 |
| --- | --- | --- | --- |
| **章节进度** | 当前读到第几章：`第 x/共 y 章 · 百分比` | PC 底栏 / 手机底栏「上一章 · 进度 · 下一章」中间文本 | 是（progress 接口） |
| **章内阅读进度** | 当前章滚动位置，滚到底 = 100% | **底部常驻细线**（2px，琥珀色进度 + 灰色轨道） | **否**，纯前端由滚动位置派生 |

### 底部细线进度

- 位置：最底边，全宽 2px，`z-50` 常驻显示——**无论菜单是否唤出都存在**，不响应点击。
- 数值 = 本章滚动比例 × 100%；换章归零，进章恢复上次位置时跟随滚动条。
- 轨道色 `rgba(128,128,128,.2)`，进度色 `rgba(245,158,11,.85)`。

### 进度上报策略（章节进度）

- **进章 / 跳章：立即上报一次**（跳章报 0，进章恢复后报恢复值）。
- **阅读中：每 5s 定时比对**上次已上报值，变化 ≥0.5 个百分点才发请求；滚动本身不发请求。
- 上报内容 = `{ chapterIdx, scrollPos }`，scrollPos 仅用于下次进章恢复位置。

## 3. 导航工具栏

### 手机（≤500px）

- **顶栏**（点正文唤出）：左返回 icon + 右文字按钮（书架/书源/目录）。**不设「首页」入口**——首页路由 `/` 就是书架，两个入口指向同一页面属于功能重叠。
- **底栏**：`上一章 · 章节进度 · 下一章` 三项居中，**不放设置**。
- **左侧浮动组**：书籍详情、缓存下载。
- **右侧浮动组**：刷新本章、朗读、**设置**——设置入口统一在右侧按钮组。

### PC（>500px）

- **左栏**：**返回 / 书架 / 书源 / 目录**（icon+文字纵向排列，**「返回」放最前面** `nav(-1)`；PC 没有手机顶栏，之前只能靠浏览器后退）。
- **右栏**（靠底）：书籍详情、刷新、朗读、设置（纯 icon 圆钮）。**底距 `bottom: 56px`（`bottom-14`）**——底栏约 33px 高，原来的 12px 会让最下面的设置钮下半截被底栏压住。
- **底栏**：`上一章 · 章节进度 · 下一章` 居中悬浮。

### 章末衔接条

- 正文最后一行是居中浅色提示 `— 本章完 · 下一章继续 —`，**整体可点**，行为与底栏「下一章」完全一致（`goChapter(idx + 1)`，末章弹「没有更多章节」）。
- 点击时必须 `stopPropagation`：正文容器点击是「显隐工具栏」，否则点章末会顺带把菜单切掉。

### PC 侧栏定位（贴正文，不贴窗口边）

- 正文 640px 居中，两侧菜单**紧贴正文边缘留 12px 间隙**：
  - 左栏锚点 `left: calc(50% - 320px)`，`translateX(calc(-100% - 12px))`；
  - 右栏锚点 `left: calc(50% + 320px)`，`translateX(12px)`。
- 断点 `≥900px` 才启用贴正文定位；500–899px 视口放不下，保持贴窗口边。

## 4. 浮动按钮样式

- 所有浮动圆钮（手机两侧 + PC 右栏）加**半透明底色 + 细描边**：
  - 暗色主题：`rgba(0,0,0,.45)` 底 + `1px solid rgba(128,128,128,.28)` 描边；
  - 亮色主题：`rgba(255,255,255,.65)` 底 + 同描边。
- 激活态（朗读中）：图标 `amber-500` 高亮，其余状态图标 75% 透明度。

## 5. 主题

- 5 预设：暗色 / 羊皮纸 / 星空蓝 / 护眼绿 / 柔和灰。**自定义主题已下线**（含色相圆盘/透明度，历史包袱大于价值）；历史遗留的 `custom`/纯黑取值在 `resolveTheme` 统一落到暗色。
- 文字色跟随预设（暗色系亮字、亮色系暗字），全部内联样式注入。
- 设置面板控件统一：半透明黑底 + 浅描边，暗色主题下按钮不与文字混色。
- **设置弹层的遮罩不加背景色**（透明点击层，只负责点外部关闭），**面板保留主题背景**（实底 + 顶部描边）；自定义颜色第二层同规则。目录/换源弹层仍保留 `bg-black/60` 遮罩（全屏列表需要压暗背后正文）。
- 所有设置（字号/行距/主题/语速/发音人）实时持久化 localStorage（`reader-prefs`）。
- 设置入口 icon 为**齿轮**（Feather settings），右侧浮动按钮组。

## 6. 朗读（TTS）

- **从当前阅读位置开始**：以滚动位置为准，取「第一个底边还在视口内的段落」作为起始段（与底部细线进度同源），不是每次从本章开头。
- **选中即起点**：正文里有选中文本时点「朗读」，从选中所在句开始读（用 `Selection` 的 range 起点偏移映射到「段落 → 句」下标，与渲染切片同源）；无选中则回到上面的可视位置逻辑。
- **按句链式朗读**：段落先切分句（`。！？!?…` 为界，句末引号/右括号跟随前句），逐句合成，语速 0.5–1.5。
- **语速/发音人改动下一句生效**：每句创建 `SpeechSynthesisUtterance` 时从 `prefsRef`/`voicesRef` 实时读取偏好，而不是开始朗读时闭包捕获——设置面板调整后当前句读完，下一句立刻用新值（朗读中不用停止重启）。
- **正在朗读的句子高亮为黄色**：当前句文字色 amber（深色主题 `#fbbf24` / 亮色主题 `#b45309`）+ `amber-400/15` 淡底；段落按句渲染成 `<span>`，仅朗读中的那段拆分，其余段落保持纯文本（不增加 DOM 开销）。
- **跟读滚动**：当前句所在段落滚出视口才 `scrollTo`（提前量 48px、定位到视口 30% 处），用户手动滚动不被强行拽回。
- **读完自动续读下一章**：本章最后一句结束 → `replace` 导航到下一章 → 新章正文就绪后从第一段继续朗读；已是最后一章则提示「已读完本书最后一章」。
- 停止/读完/切章时清除高亮（`spoken = null`）。
- 切章 / 换源 / 卸载页面会打断朗读（`ttsStopped` 标志避免 cancel 触发的 onend 继续读旧章）。

## 11. 定时巡检与书籍编辑

- **定时巡检（后端）**：服务启动后启用后台定时器，每 `UPDATE_INTERVAL_MS`（默认 6×3600×1000，**0 关闭**）遍历**书架里的书**（`books join shelf`，预览过但没人收藏的不巡检），逐本重抓目录比对章节数；仅「新增章节」才置 `updatedAt`（影响书架「最近更新」排序），纯检查不动排序时间。复用检查更新的抓取逻辑，按书源限速器限流、两本之间留 800ms 间隔，避免远程浏览器任务相互抢占。日志落 `data/logs`，不阻塞请求。
- **每日孤儿清理（后端）**：每 `CLEANUP_INTERVAL_MS`（默认 24h，**0 关闭**）扫 `books left join shelf where shelf.book_id is null` 且 `created_at` 早于 `CLEANUP_GRACE_MS`（默认 24h）的书 → 删 chapters / progress / books，并按 `contentKey = sha1(bookUrl)` 释放正文缓存与 cache_jobs（**同一 bookUrl 还有别的书籍行在用就保留**）。随后再扫一遍 `chapter_cache` 的 distinct content_key，清掉「没有任何书引用」的孤儿缓存（换源后的旧地址残留）。启动 2 分钟后先跑一次，之后按周期跑。
- **用户上传封面受保护**：巡检以源站封面覆盖 `cover`，但若当前 `cover` 以 `data:` 开头（本地上传）则**保留不动**——用户自定义封面不会被源站更新冲掉。
- **编辑书籍元数据**：`PATCH /api/books/:id`，仅更新传入字段（name/author/intro/latestChapter/cover）。封面校验：以 `data:` 开头须是 `data:image/`（上限 2MB，前端已压缩）；否则须为 http(s) URL；空串即清除。其余字段按长度截断（name≤200/author≤100/intro≤4000/latestChapter≤300）。
- **前端编辑弹层**：书籍详情页新增「编辑」按钮 → 底部弹层（无背景遮罩色、面板实底），书名/作者/简介/最新章节为文本框；**封面 = URL 输入框 + 上传图片**二选一，上传时 canvas 压缩至最长边 360px 的 JPEG(0.82) 转 dataURL 预览，可「清除封面」。保存走 PATCH，成功 toast + 重新加载详情。
- **引擎假死自愈**（症状：点朗读一直没声音，刷新页面无效，重启浏览器才恢复——Web Speech 引擎进入坏状态）：
  - **先 `resume()` 再 `cancel()`**：对 paused 状态的队列直接 cancel 无效，是假死最常见成因；所有打断/复位走统一的 `resetTts()`；
  - **持有当前 Utterance 引用**（`curUtter`）：Chrome 曾有 utterance 被提前 GC 导致无声且 onend 永不触发的 bug；
  - **起播看门狗**：`speak()` 后 3s 内 `onstart` 没来判定假死，cancel 后自动重试本句一次；重试仍无声提示「请完全退出浏览器后重试」；
  - **读句兜底**：onstart 后按「文本长度 × 600ms ÷ 语速」（下限 4s）设超时，onend 偶发丢失时自动放行下一句，朗读链不中断。
- **iOS 静音开关无外放（会话类别适配）**：iOS 上 Web Speech 合成的音频归属**环境音（ambient）**类别的音频会话，侧边静音开关一拨到静音，外放直接哑掉；耳机不走这条路由，所以「戴耳机有声、外放没声」。修法是在朗读期间把会话抬到 **playback** 类别（与 `<audio>`/`<video>` 同级，静音开关管不到），双手段叠加：① `navigator.audioSession.type = "playback"`（Safari 16.4+ / iOS 17+ 的 Web Audio Session 接口，首选）；② 挂一条 1 秒静音 WAV 音轨循环播放（`volume` 保持 1，WebKit 可能把 `volume=0` 判为「没在播」而不抬会话），给没有该接口的旧系统兜底。`holdAudioSession()` 在点朗读的手势栈里调用（iOS 不放行无手势的首播），`stopTts`/读完最后一章/引擎报错/离开阅读器时 `releaseAudioSession()` 归还会话；**章节自动续读期间不清会话**（续读发生在异步回调里，重新抢会话可能拿不到用户手势）。仅 iOS 启用，桌面端不创建多余音频元素。实现见 `web/src/tts-audio.ts`。
- 发音人列表**只列中文**（`lang` 以 `zh` 开头）且**排除 Eloquence 系列**（iOS 内置机械音，`voiceURI` 含 eloquence 一律过滤），已保存的被过滤发音人自动清除；用户在系统设置里新下载的中文发音人（增强版/Siri 声音等）会随 `voiceschanged` 事件自动进入列表，无需改代码。
- **同名发音人去歧义**：系统里「婷婷」和「婷婷优化版」是两条不同音质的语音，但 `name` 可能完全一样（只有 `voiceURI` 不同）——**不不去重**（去掉就用不上优化版了），改为同名出现 ≥2 次时从 `voiceURI` 提取标签区分：`enhanced`→优化版、`premium`→高级版、`siri`→Siri、`compact`/`ttsbundle`→标准版，兜底取 URI 最后一段；另按 `voiceURI` 整体去重防系统返回重复条目。

## 7. 章节导航与历史

- 上一章 / 下一章 / 目录跳章一律用 **`replace`** 导航：历史栈只保留「书籍详情 → 阅读器」两层，返回键回书籍详情，不会退成上一章。
- 换源后进度保留，章节号越界回第 0 章。

## 8. 交互细节备忘

- 工具栏默认隐藏，**点击正文切换**显隐（chrome state）；弹层打开时不受影响。
- 顶栏第一个 icon「返回」= `nav(-1)` 返回上一个路由，不是上一章。
- 目录弹层：当前章 amber 高亮 + 「已缓存」绿点标记，**打开即把当前章滚到列表中央**（见 §9）；换源面板列出拥有此书的源，当前源禁用。
- 占位内容 toast 与操作 toast 均悬浮顶部居中，不推挤内容。
- 书架排序（顶部 tab）：
  - **最近阅读**（默认）：按 `progress.updated_at` 降序，未读过的排后面按加入时间；
  - **最近更新**：按 `books.updated_at` 降序（首次建目录、检查更新发现新增章节时置为当前时间；单纯检查不动）。
- 主题/朗读/TTS 相关状态全部本地，允许离线（PWA）。

## 9. 目录弹层定位与操作动效

### 目录列表定位（当前章居中）

- 入口：手机顶栏 / PC 左栏「目录」。打开弹层时**把当前章那一行滚到列表竖直中央**——目录常有上千章，落点若停在第 1 章，想找当前章得手动翻很久。
- 算法：取滚动容器 `tocRef` 与当前行 `curChRef`，`容器.scrollTop += 行.top − 容器.top − (容器.height − 行.height)/2`。
  - **不用 `scrollIntoView`**：它会把 body/正文一起滚，阅读位置被连带改掉。
  - 用 rect 差值而非 `offsetTop`：行不依赖 offsetParent 链（弹层内有多层定位容器）。
  - 首章/末章受滚动边界限制，贴顶/贴底即止，不做视觉补偿。
- 定位时机：依赖 `[showToc, chapters.length, idx]`——覆盖「先开弹层、目录后到」的异步顺序；切章后再开同样重新居中。用 `requestAnimationFrame` 等一帧，保证行高已排版。
- 当前章视觉：amber 文字 + `amber/10` 淡底 + 中等字重（只有文字变色时，居中后不易一眼锁定）；「已缓存」绿点、「· 当前」后缀保留。

### 强制刷新旋转动画

- 「刷新本章」（`?refresh=1` 绕过缓存重抓正文）请求期间图标 `animate-spin` 匀速旋转，按钮同时 `disabled` 防重复点击；返回后（成功或报错 toast）立即停转。
- 旋转施加在包图标的 `<span>` 上，**不是按钮本身**：按钮位置、底色描边和 hover 逻辑不跟着转。
- 移动端右侧两组按钮与 PC 右栏共用同一个 `FloatBtn` 的 `spinning` 属性，两端行为一致。

### 弹层关闭按钮（点透修复）

- **症状**：移动端点目录弹层的「×」，弹层卸载后同一次点按的合成 click 落到弹层下方的章节行上，直接跳章（iOS 点透）。
- **结构层根治（首选方案）**：目录/换源弹层**头部（标题+关闭钮）与列表上下排列，不再用 sticky 覆盖**——面板 `flex h-full flex-col`，头部 `flex-none`，列表区 `flex-1 overflow-y-auto` 自己内部滚动（`tocRef` 即列表滚动容器，当前章居中算法不变）。这样「×」下面是面板容器（`stopPropagation`），即使发生点透也只落在不可点的容器上，**从结构上让「盖住」不存在**。
- **`SheetClose` 组件（目录/换源/设置三弹层共用）**：`touchend` 阶段 `preventDefault()` 吞掉合成 click 并直接关闭；`touchstart` 记录起点，手位移 >10px 视为滚动收尾不当作点按；桌面仍走 `onClick`。
- **时间戳护栏（保险丝，`tapGuard`）**：`closeSheet(setter)` 统一关闭入口记录 `tapGuard = Date.now() + 500`；下层易误触的 onClick（目录章节行、换源条目、正文切工具栏）开头检查即忽略。结构修复后护栏只兜极端场景（关闭后合成 click 重定位到弹层外的元素，如误切工具栏），代价一行，**保留不删**。
- 通用教训：**移动端「可点列表 + 覆盖其上的悬浮关闭钮」是点透温床**——优先用上下排列消除覆盖；确需覆盖时再上 SheetClose + tapGuard 双保险。

# 五、部署与运维（Linux + supervisord）

## 1. 进程模型：supervisord 直接跑 bun，不要套 `bun run start`

- `bun run start` 只是「读 package.json 的 scripts.start 再起一个子进程」，实测进程树是 `bun run start` → `bun run src/index.ts`（真正的服务）**两层**。
- supervisord 的 `stopsignal` 只发给它直属的那个 pid。发到 wrapper 时，真正监听端口的子进程可能被 init 收养继续活着：端口一直被占，新进程 bind 报 EADDRINUSE —— 日志里就是「重启失败」+ 旧实例还在跑。
- 因此 `command` 直接写解释器 + 入口文件，并用 `directory` 指定工作目录（`data/`、`web/reader` 都是相对 cwd 的路径）：

```ini
[program:reader]
directory=/srv/bun-reader
command=/root/.bun/bin/bun src/index.ts
environment=PORT="8094",CDP_URL="http://127.0.0.1:9222"
autostart=true
autorestart=true
startsecs=3
stopsignal=TERM
stopwaitsecs=15
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/reader.out.log
redirect_stderr=true
```

`CDP_URL` 指向 kasmweb/chrome 容器的 CDP 端点（默认即 `http://127.0.0.1:9222`，同 compose 的宿主映射）。`stopasgroup/killasgroup` 保留兜底——本地已不拉起 chromium，远程浏览器随 docker 管理。

## 2. 启动顺序（`src/index.ts`）

1. `Bun.serve()` 绑端口 → 打 `listening` 日志（健康检查最先能过）；
2. 延迟 1s 再做耗时初始化：`materializeScripts()`（脚本源落盘重建）+ 书籍巡检注册 + 孤儿清理注册。期间请求打到脚本源时由 `ensureScriptFile` 惰性补单个脚本，不依赖全量重建；
3. 端口被占时按 `BIND_RETRIES`（默认 3）每 1s 重试——旧进程刚收 SIGTERM、socket 还差几百毫秒才释放的窗口就这样吃掉；仍失败则打印 `ss -lptn 'sport = :PORT'` / `lsof -i:PORT` 查到的占用者，然后 `exit 1`。

## 3. 退出顺序

`SIGTERM`/`SIGINT` → `server.stop(true)`（端口立刻释放，在途 SSE 不拖泥带水）→ `await closeBrowser()`（最多等 2.5s，清掉本进程在远程浏览器里打开的页）→ `exit 0`。另有 4s 兜底强退，保证短于 supervisord 的 `stopwaitsecs`。

**closeBrowser 不关远程浏览器**：kasmweb/chrome 是共享常驻实例，`browser.close()` 会断开连接并清上下文；退出流程只关本进程打开的 tab、丢弃连接引用（WS 随进程消亡），远端 Chrome 与 VNC 会话不受影响。历史包袱（本地 chromium 子进程被 init 收养、占 profile 锁、继承监听 fd 致 EADDRINUSE）随远程化自然消失。
