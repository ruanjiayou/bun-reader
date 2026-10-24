# bun-reader 设计文档

> 日期：2026-10-24
> 定位：借鉴 Legado（阅读）的多用户 Web 阅读器，PWA 形态，书源引擎为核心价值。

## 1. 需求画像

- **部署形态**：自部署多人系统，支持登录注册（几个熟人共用，非公开多租户）
- **核心价值**：兼容 Legado 书源生态（JSON 格式直接导入），服务端抓取在线书站
- **目标设备**：手机 PWA 为主 + 桌面浏览器均衡适配
- **首版功能**：核心阅读链路 + TTS 朗读 + 书源调试工具 + 阅读器内刷新
- **明确不做**：漫画/RSS、换源、净化规则管理、WebDAV、JS 脚本书源、仿真翻页动画、邮件找回密码

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
│            Bun 进程 (:3000)               │
│  Hono 路由 ──┬── 静态资源 (React 构建产物)  │
│              ├── /api/*                   │
│              ├── /auth/*  (JWT Cookie)    │
│              └── 书源规则引擎 (cheerio)     │
│  bun:sqlite (book.db)                     │
│  data/cache/{sha1(book_url)}/{idx}.txt    │
│  定时任务: 书架更新检查 (setInterval)       │
└───────────────────────────────────────────┘
```

## 3. 认证

- 用户名 + 密码（bcrypt），JWT 放 httpOnly Cookie，中间件统一校验
- API：`POST /auth/register`、`POST /auth/login`、`POST /auth/logout`、`GET /auth/me`
- 不做邮箱验证、找回密码

## 4. 数据模型

SQLite 表 + 磁盘文件：

| 表 | 字段 | 说明 |
|---|---|---|
| `users` | id, username, password_hash, created_at | 多用户 |
| `sources` | id, name, enabled, "group", json, last_use_at | **全局共享**，Legado 书源 JSON 原文存库 |
| `books` | id, user_id, book_url, source_id, name, author, cover, intro, latest_chapter, last_check_at | 书架；唯一约束 (user_id, book_url, source_id) |
| `chapters` | id, book_id, idx, title, url | 目录快照，加书架时抓取，按需刷新 |
| `chapter_cache` | content_key(sha1(book_url)), idx, file_path, size, fetched_at | 正文索引；文件在 `data/cache/` |
| `progress` | book_id, chapter_idx, scroll_pos, updated_at | 随 book 按用户隔离 |
| `settings` | user_id, key, value | 阅读偏好 |

**正文落盘**：`data/cache/{sha1(book_url)}/{idx}.txt`。库只存元数据；同一本书不同用户天然共享缓存；清理即删目录；正文 <50 字视为疑似占位（触发阅读器刷新提示）。LRU 策略控制总量（约 5000 章）。

## 5. API 概要

- **书源**：`GET/POST/DELETE /sources`（支持 URL 批量导入 / 粘贴 JSON / 文件上传）、`POST /sources/:id/test`（体检）、`POST /sources/:id/debug`（SSE 调试日志）
- **搜索**：`GET /search?q=` — 并发扇出全部启用源（每源并发 1、间隔 300ms、总超时 15s），**SSE 流式返回**；前端按书名+作者聚合去重；面板底部显示各源完成/失败状态
- **书架**：`GET /books`、`POST /books`、`DELETE /books/:id`
- **目录**：`GET /books/:id/category`（`?refresh=1` 强制刷新）
- **正文**：`GET /books/:id/content/:idx`（`?refresh=1` 绕过缓存重抓）
- **进度**：`PUT /books/:id/progress`

### 书源调试页（首版即做）

`POST /sources/:id/debug` SSE 流式推送，四步流水线：**搜索关键词 → 书详情 → 取目录 → 取首章正文**。每步记录：实际请求 URL、响应码/编码/耗时、规则命中结果（截断展示）、失败原因。前端桌面左右分栏（规则编辑 | 调试日志），手机上下堆叠。

## 6. 书源规则引擎

**书源 JSON 格式完全兼容 Legado**；引擎内部将 Legado 选择器语法翻译为 cheerio 调用。

| 语法 | 示例 | 首版 |
|---|---|---|
| JSoup 选择器 | `class.bookname@tag.a@text` | ✅ 支持 |
| 选择器 + 正则净化 | `id.content@textNodes##广告.*?删` | ✅ 支持 |
| XPath / JSONPath | `//div[@id="content"]/text()`、`$.xxx` | ✅ 变体顺带支持 |
| JS 脚本 | `<js>...</js>`、`{{...}}` | ❌ 标记不支持并跳过该源（二期沙箱补） |

抓取管线：构造模板 URL（`{{key}}`）→ fetch（书源 headers 优先，默认浏览器 UA/Referer）→ 编码识别（GBK/GB2312 用 iconv-lite，默认 UTF-8）→ 规则提取 → 正文正则净化 → 落盘。

限流：每源串行 + 300ms 间隔，超时 10s，失败不阻塞其他源。

## 7. 前端页面

| 路由 | 页面 | 要点 |
|---|---|---|
| `/` | 书架 | 手机 3 列网格 / 桌面 4~6 列或列表；更新角标；长按/右键菜单 |
| `/search` | 搜索 | SSE 实时追加结果卡片，聚合去重 |
| `/book/:id` | 书籍详情 | 简介、目录入口、继续阅读（直达进度） |
| `/book/:id/category` | 目录 | 章节列表、倒序切换、已读标记 |
| `/book/:id/read/:idx` | 阅读器 | 见下 |
| `/sources` | 书源管理 | 列表启停、三种导入、调试页 |

### 阅读器交互

- 点击：左 1/3 上一页、右 1/3 下一页、中间呼出菜单
- 菜单：顶部（返回/书名/设置）、底部（**刷新按钮**、进度滑块、上下章、朗读按钮）
- 本章正文 <50 字时刷新按钮红点提示"疑似占位内容"
- 设置面板：字号/行距/页边距、亮/暗/羊皮纸主题、系统字体可选
- 翻页：CSS transform 平移滑动（不做仿真卷曲）
- 预加载：读当前章时后台预取下一章
- TTS：SpeechSynthesis 按段朗读，自动滚动高亮，底部播放条

### PWA

manifest + 图标 + App Shell 预缓存；已读章节 runtime cache，断网可读。

## 8. 错误处理

- 搜索：单源失败静默跳过，底部汇总"已完成 45/52（7 失败，点击查看）"
- 正文失败：阅读器内联重试卡片，不白屏
- 源自动停用：连续 5 次正文失败 → 标记停用
- 后台任务：逐源逐书 try/catch，日志落 `data/logs/update.log`
- 迁移：drizzle-kit，启动自动 migrate，幂等

## 9. 里程碑

| 期 | 内容 | 验收标准 |
|---|---|---|
| M1 骨架 | Bun+Hono+SQLite+登录注册、React 脚手架、PWA 壳 | 能登录，手机可安装 |
| M2 书源引擎 | cheerio 规则引擎 + 导入 + 调试页 + 体检 | 导入 10 个社区源 ≥6 个三步全绿 |
| M3 核心阅读 | 聚合搜索(SSE)→书架→目录→正文→进度 + 缓存落盘 | 真实书源完整阅读闭环 |
| M4 体验完善 | 菜单/设置/主题、预加载、后台更新、TTS、角标 | 日常替代 Legado 无卡点 |

二期候选（优先级序）：JS 沙箱脚本源 > 换源 > 净化规则。

## 10. 主要风险

- 规则引擎工作量约占全项目 40%，无现成 TS 库可复用
- 社区书源质量参差，需调试页 + 体检工具持续筛选
- JS 脚本源不支持意味着约 15% 书源（多为反爬复杂站）首版不可用
