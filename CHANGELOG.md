# Changelog

按日期记录功能变更（设计规范见 [docs/design.md](./docs/design.md)，当前计划见 [docs/plans.md](./docs/plans.md)）。

## 2026-10-26

- **API 网关前缀**：前端所有请求统一加 `/gw/reader` 前缀（`api.ts` 的 `API_BASE`，可用 `VITE_API_BASE` 覆盖，置空串直连同源 `/api`）；vite dev 代理 `/gw/reader` → `http://192.168.1.124`（路径原样保留，网关不剥前缀）；后端补 `/gw/reader/api`、`/gw/reader/auth` 别名路由（与 `/api`、`/auth` 等价，网关直接转发也能命中）

## 2026-10-25

- **浏览器单实例双模式**：调试/预览有头、真实抓取（目录后台补/全本缓存/正文/检查更新）无头，`runWithBrowserMode` 注入；同 profile 切换（等空闲→重启，cookie 保留），无头 UA 去 HeadlessChrome 特征
- **69书吧全浏览器链路**：全站 Cloudflare Turnstile + TLS 指纹校验（cookie 提取也不够），转脚本源四方法全走 Playwright；反自动化启动参数让 Turnstile 自动通过（webdriver 特征）；BrowserPage 页内 fetch 支持 POST（搜索表单）；fetchText 自动合并浏览器同域 cookie
- **HTTP 空闲超时放宽**：Bun.serve idleTimeout 10s→255s（目录多页翻页等长请求不再被服务端掐断）
- **阅读器 UI 细化**：底部细线改为章内滚动进度（滚到底 100%，不同步后端）；手机底栏去掉设置（入口移右侧按钮组）；PC 两侧菜单 ≥900px 贴正文边缘；浮动圆钮加半透明底色描边；新增阅读器 UI 设计规范（docs/design.md 第四部分）
- **正文段落换行**：规则引擎新增 `.textBlocks()`（最内层块级元素、嵌套 p 去重、br 转换行、跳过裸广告文本）；思兔/幽香两源规则与脚本已迁移
- **header 统一对象化**：normalizeSource 宽松解析字符串 header（容错 devtools 复制片段）入库为对象；修复思兔坏 JSON header、幽香脚本源 headers 二次编码（展示/生成代码/运行时三处 + 存量数据）
- **进度上报策略**：进章/跳章立即上报；阅读中 5s 定时比对、变化 ≥0.5 才发；滚动只更新细线不发请求
- **阅读抓取计入限速**：正文路由 cache miss 走同源 RateLimiter，与全本缓存共享预算
- **Playwright 导航竞态修复**：page.content() 导航中报错改为等 load 重试（safeContent）
- **幽香书房 Playwright 化**：browser.ts 有头浏览器（持久化 profile 自动存 cookie、Chrome/Edge/chromium 探测、WAF 验证码等待人工通过）；目录抓取走浏览器驱动加密 AJAX，超时放宽 600s
- **缓存自适应限速器**：滑动窗口计频（成功数/60s），失败减半且 high 不可触及，仅「前面成功后失败」才减频；频率按书源持久化 rate_states 表
- **进度/布局/日志**：缓存章节日志回归后端（data/logs）；阅读器工具栏悬浮定位（正文铺满不位移）；书籍详情重排（封面左信息右、缓存条居中）
- **阅读器交互与主题**：chrome 点击正文显隐、主题 6 预设 + 自定义色/透明度、行距加减按钮、语速 0.5–1.5、设置 localStorage 持久化
- **脚本源表单制**：四方法各一表单项（留空=未实现），保存时 formToCode 合并生成 class；存量源恢复 rules 模式不迁移
- **脚本书源引擎上线**：runtime 注入 API + class 加载器（data:URL 直载避 Windows 竞态）+ facade 分流 + 规则→JS 转换器（产出与规则引擎一致）
- **缓存限速**：250ms→1s→自适应（失败翻倍退避）；跳过阅读时已落盘章节不重复请求

## 2026-10-24

- **书源规则语法 v2**：链式调用风格（`h1.text()`/`.attr('href')`/`.find('a')`），去掉 @ 分节器；normalizeSource 幂等迁移，存量源自动兼容；`:eq(N)` 原生透传、选择器引号包裹
- **目录翻页增强**：`{page}` 模板翻页 + 由最新章节链接反推最大页码（精确抓 1..max 不盲试）；最新章节双取（URL 推页码 / 标题入库展示）
- **全本缓存**：后台批量抓取任务（cache_jobs 表、contentKey 共享、可停止）、缓存绿点、释放缓存
- **M3 核心阅读**：聚合搜索 SSE、书架/目录/正文磁盘缓存/进度 API、阅读器（滚动模式/菜单/设置/预加载/TTS/占位刷新提示）
- **换源**：阅读器内换源面板（选源→书名搜索→一键换源，进度保留）
- **加书架秒回**：books 表直接落库，目录后台异步抓取
- **Web 部署细节**：/reader 前缀（Hono 302 无尾斜杠兼容）、vite 局域网访问、BrowserRouter basename
- **正文分页合并**：nextContentUrl 翻页拼接 + 4xx/5xx 重试退避（1s/2s/4s）
