# Changelog

按日期记录功能变更（设计规范见 [docs/design.md](./docs/design.md)，当前计划见 [docs/plans.md](./docs/plans.md)）。

## 2026-10-29（续 6）

- **重启仍报「端口 8094 被占用」：定位到进程树 + 退出流程两处**
  - 真凶不是 chromium 本身（浏览器是客户端，不监听端口），而是 `supervisord → bun run start → bun run src/index.ts` 的**两层进程**：SIGTERM 只打到 wrapper，真正监听端口的子进程被收养继续跑；旧实例不退，新实例永远 bind 失败。日志特征：`waiting for reader to stop` × 5 → `SIGKILL` → `reaped unknown pid ...` → 新 pid 立刻 EADDRINUSE
  - `src/index.ts` 退出流程改为固定顺序：`server.stop(true)`（端口立刻释放）→ `await closeBrowser()`（≤2.5s）→ `exit 0`，另有 4s 兜底强退
  - `src/source/browser.ts` 新增可 await 的 `closeBrowser()`：真正关掉持久化 context 再退出，避免 chromium 子进程被 init 收养后继续占用 `data/browser-profile` 锁、甚至带着继承来的监听 fd 不放
  - 端口绑定加**重试**（`BIND_RETRIES`，默认 3 次 / 1s 间隔），吃掉旧进程刚退出那一小段释放窗口；仍失败时打印 `ss -lptn` / `lsof -i` 查到的占用者再 exit 1
  - `docs/design.md` 新增「五、部署与运维」：supervisord 用 `command=bun src/index.ts` + `stopasgroup/killasgroup`，别再套 `bun run start`
  - 实测：同端口第二个实例会打 `端口 8098 被占用，1s 后重试（1/3）`→（2/3）→ `监听失败…` 后 exit 1，第一个实例不受影响；测试 74 全绿，`tsc --noEmit` 通过

## 2026-10-29（续 5）

- **启动顺序调整：先监听端口，再做耗时初始化**（重启失败的根因）
  - `Bun.serve()` 提到最前，`listening` 日志紧跟其后；脚本源落盘重建（逐条查库 + 读写文件 + 编译校验）与书籍巡检注册改为**监听成功后延迟 1s** 执行——以前它们在 `Bun.serve` 之前启动，端口就绪被推迟，部署脚本/反代的健康检查等不到端口就判定「启动失败」并杀进程
  - 延迟期间若有请求打到脚本源，`ensureScriptFile` 仍会惰性补出单个脚本，不必等全量重建
  - 端口占用不再抛整段栈：改为一行 `端口 8095 监听失败：…（是否已有实例在运行？）` 并 `exit 1`
  - 补 **优雅退出**：SIGTERM/SIGINT 时 `server.stop(true)` 立即释放端口再退出，避免重启时新进程 bind 撞上旧进程还没退干净的 EADDRINUSE
  - 实测（本地 8095）：`listening` → 1s 后落盘/巡检日志；占用端口时一行明确报错；退出后端口立即可再次绑定

## 2026-10-29（续 4）

- **支持 Legado 的 `text.xxx`（按文字找元素）**：`text.下一页@href` 以前转换器原样保留（CSS 无文本伪类），选择器无效 → 正文翻页静默失效，next 永远取到空
  - 转换 `text.xxx` → `*:contains("xxx"):not(:has(*:contains("xxx")))`：取「自身含该文本、子孙不再含」的最内层元素，近似 `//*[text()="xxx"]`；不加最内层限制会连 body/html 一起命中
  - 支持索引写法 `text.下一页.-1@href`；中间段也能用（`class.pager@text.下一页@href` → `.pager.find('*:contains(...)')`）
  - `attr('href')` 求值时若命中元素自身没有 href（如 `<a href><span>下一页</span></a>` 命中 span），向上取最近带 href 的祖先，取文本时行为不变
  - **存量兼容**：老转换器把规则原样存成了 `text.下一页.attr('href')`，现在 `normalizeSource` 会识别「text.段 + 已是 v2 调用链」并替换成正确选择器；脚本源 `runtime.ruleText/ruleSel` 也统一先过 `legadoToOurs`，已生成的旧脚本不用重新生成即可恢复
  - 前端正文分组「章节内翻页」提示补一行 `text.下一页@href（按文字找，Legado 写法）`
  - 测试 69→74（规则转换/求值/幂等/存量、规则源三页翻页、转换器脚本一致性、旧脚本存量兼容）

## 2026-10-29（续 3）

- **调试日志按「一行一条」输出**：详情解析后不再把书名/最新章节/目录地址拼成一行，改为逐条推送——`书名:` `作者:` `封面:` `简介:` `最新章节:` `目录地址:`，缺失项标 `⚠️未取到`，一眼看出哪条规则没配好（规则源与脚本源 `getDetail` 均如此）
- **没翻页也打日志**：目录/正文以前只在「有翻页」时输出过程日志，单页章节或规则没命中时一片空白，分不清是「本来不分页」还是「规则没配」
  - 目录：`目录无翻页：未配置 nextTocUrl（按单页处理）` / `目录无翻页：下一页规则未命中链接…` / 多页结束时 `目录翻页结束：第 N 页没有下一页链接`
  - 正文：`正文无翻页：未配置 nextContentUrl（按单页处理）` / `正文无翻页：nextContentUrl 未命中下一页链接…`（脚本源为 `源未返回 next`）/ 多页结束时 `正文翻页结束：第 N 页…`
- `test/content-paging.test.ts` 补 3 例（单页目录、翻页规则未命中、详情字段分行），测试 66→69

## 2026-10-29（续 2）

- **书源规则支持章节内翻页（正文分页）**：很多站点正文一页放不下、末尾带「下一页」，现在可配置
  - 规则表单「正文」分组新增 **章节内翻页**（`ruleContent.nextContentUrl`）——之前引擎支持但表单没有输入框，等于配不了
  - 两种写法：下一页链接 `'.bottem a:eq(3)'.attr('href')`（取到空即结束、地址已抓过即停、上限 50 页）；分页地址有规律时用 `{page}` 模板 `{{bookUrl}}##_?\d*\.html$##_{page}.html`（首次求值识破为模板，之后不依赖页内链接，按页码 2,3,4… 展开）
  - `{{bookUrl}}` 在正文里语义是**当前页地址**（base 传本页 URL）；模板 URL 不过 `new URL()`，避免 `{page}` 被编码成 `%7Bpage%7D`
  - **收口**：新页正文与上一页完全相同 → 判定站点对任意页码返回同一页，停止（模板盲试必须靠这条）；第 2 页起失败保留已抓页，不整章报废
  - 脚本源 `getContent` 返回的 `next` 同样支持 `{page}` 模板；第 2 页起抓取失败改为保留已抓部分（原来整章失败）
  - 转换器：`nextContentUrl` 生成 `{text, next}` 时把 `res.url` 作为 `ruleText` 的 base，`{{bookUrl}}` 语义与规则引擎一致
  - 新增 `test/content-paging.test.ts`（10 例）+ 转换器一致性用例（测试 56→66）

## 2026-10-29（续）

- **阅读器 PC 右下设置钮不再被底栏压住**：右侧浮动栏底距由 12px 抬到 56px（`bottom-14`），底栏约 33px 高，原来设置钮下半截被盖住
- **章末衔接条可点**：正文末尾 `— 本章完 · 下一章继续 —` 改为按钮，行为与底栏「下一章」一致（含末章提示）；点击 `stopPropagation`，避免顺带切换工具栏
- **书籍详情页按钮排与书源标识**：开始阅读/继续阅读不再 `flex-1` 拉满，与移出书架/检查更新/编辑一样按内容定宽、**整排左对齐**；缓存信息与缓存全本/停止/释放从页头移到**阅读按钮下方一排**，该排左侧显示**本书所属书源名**（前端靠 `GET /api/books/:id` 新增的 `sourceName`）

## 2026-10-29

- **脚本源落盘改为「自动生成」**：`data/sources/{id}.js` 只是产物，数据库 `code` 列才是真相
  - 启动时 `materializeScripts()` 扫描 `type=script` 的源，文件缺失或头部不是相对路径 → 按 `code` 重新生成（日志「脚本源落盘重建 n/N」）；删掉整个 `data/sources` 重启即可恢复
  - 运行时 `loadInst` 前先 `ensureScriptFile()`：文件被删也当场补出来，不用重启；调用方没带 code 时回查数据库
  - 不再做「路径自愈」（改旧文件里的路径），一律按 `code` 重新生成
- **修复脚本源跨平台加载失败**：脚手架曾把保存时那台机器的绝对路径写死（`file:///D:/projects/bun-reader/src/source/runtime.ts`），随库搬到 Linux 后被解析成 `/D:/projects/...`，定时巡检报 `Cannot find module ... imported from data:text/javascript`
  - 脚手架改为**只写相对路径** `"../../src/source/runtime.ts"`，数据文件从此机器无关
  - 加载时把该说明符改写成本机 `pathToFileURL(runtime.ts)`；runtime 位置按 `BUN_READER_RUNTIME` → `import.meta.dir` → `PROJECT_ROOT/src/source` 依次探测
  - 新增 `test/script-runtime-path.test.ts`：文件缺失自动生成、老格式按 code 重建、无 code 明确报错、启动扫描幂等（测试 51→56）

## 2026-10-28（续 3）

- **书源列表页与编辑页拆分**：`/sources` 现在是列表页（顶栏左=返回书架 icon、右=新建；每行=源名称+角标+该源书籍数+调试 icon+删除 icon，筛选/导入/导出也移到这里）；`/sources/new` 新建、`/sources/:id` 编辑，`?tab=debug` 直接从调试进入（列表的调试 icon 就带这个参数）；新建保存后 `history.replaceState` 把 URL 换成 `/sources/:id`（保留 `/reader` 前缀、不进历史）
- **`GET /api/sources` 增加 `bookCount`**：按 `books.book_url` 去重统计该源下书籍数
- **危险操作统一确认弹层**：新增 `web/src/Confirm.tsx`（`useConfirm()`），替换书架移出、详情页释放缓存/移出书架、书源删除、阅读器换源的 `window.confirm`（iOS PWA 下 confirm 样式不可控、可能被静默吞掉）；`desc` 写明影响范围与能否恢复；书源编辑页带未保存改动返回列表也会先确认

## 2026-10-28（续 2）

- **修复 iOS 升级后朗读只耳机有声**：iOS 上 Web Speech 走环境音（ambient）会话，侧边静音开关打开就无外放、耳机仍正常。新增 `web/src/tts-audio.ts`：朗读期间 `navigator.audioSession.type = "playback"`（iOS 17+）+ 循环播放 1s 静音 WAV 兜底抬会话；停止/读完/报错/离开阅读器时归还，章节自动续读期间保持不清理。仅 iOS 生效

## 2026-10-28（续）

- **新增定时巡检任务（后端）**：服务启动后启用后台定时器，默认每 6 小时（`UPDATE_INTERVAL_MS`，置 0 关闭）遍历全部书籍逐本重抓目录比对章节数；仅新增章节才置 `updatedAt`（影响书架「最近更新」排序）。复用检查更新逻辑，按书源限速器限流、两本间隔 800ms；用户本地上传封面（data: 开头）不被源站封面覆盖
- **新增书籍编辑（封面/元信息）**：`PATCH /api/books/:id` 仅更新传入字段，封面校验 data: 图片（≤2MB）或 http(s) URL；书籍详情页加「编辑」按钮 → 底部弹层，书名/作者/简介/最新章节文本框 + **封面 URL 输入与上传图片**（canvas 压缩至 360px JPEG 转 dataURL 预览），保存后重加载

## 2026-10-28

- **阅读器导航去重**：顶栏与 PC 左栏移除「首页」入口——首页路由 `/` 即书架，两个入口指向同一页面功能重叠；现为「返回 + 书架/书源/目录」
- **目录弹层点透彻底修复**：采用**结构层根治**——目录/换源弹层改为头部（标题+关闭钮）与列表上下排列、列表内部滚动（`flex h-full flex-col`，列表区 `flex-1 overflow-y-auto`），「×」下面是面板容器而不是章节行，点透无从发生；当前章居中定位不变（`tocRef` 指向列表滚动容器）。`SheetClose`（touchend preventDefault）与时间戳护栏（`tapGuard` 500ms，兜底「关闭后合成 click 重定位到弹层外元素」的极端场景）保留作双保险
- **朗读（TTS）增强**：
  - **选中即起点**：正文中选中文本后点「朗读」，从选中所在句开始读（Selection 偏移映射到段落/句下标）；无选中则维持原「从当前可视位置开始」
  - **语速/发音人改动下一句生效**：每句创建 Utterance 时从 `prefsRef`/`voicesRef` 实时读取偏好（原来在开始朗读时闭包捕获，改设置不生效），调整后当前句读完即换新值，无需停止重启
  - **发音人过滤 Eloquence 系列**（iOS 内置机械音）；系统里新下载的中文发音人（增强版/Siri 声音等）随 `voiceschanged` 自动出现在列表，直接可用
  - **同名发音人去歧义**：「婷婷」与「婷婷优化版」等两条语音 `name` 相同（只有 `voiceURI` 不同）时不去重，改为从 URI 提取标签区分（enhanced→优化版 / premium→高级版 / siri→Siri / compact→标准版，兜底取 URI 末段）；另按 voiceURI 整体去重防重复条目
- 设计文档同步：§3 导航工具栏（去首页）、§6 朗读（选中起点/实时偏好/发音人过滤）、§9 弹层关闭（时间戳护栏两层防线）

- **设置功能改版**：设置弹层**遮罩去掉背景色**（透明点击层，面板保留主题背景，不再整屏压暗）；主题**移除「纯黑」并下线整个自定义主题**（色相圆盘/透明度一并移除，历史遗留取值自动落到暗色）
- **数据层收敛**：`db.ts` 移除启动期 `ALTER TABLE` 补列代码（users.nickname/avatar、books.updated_at、sources.type/code 已并入 `CREATE TABLE`，存量库已手动迁移过）——表结构以 CREATE 语句为唯一事实来源，启动更快、日志更干净
- **朗读卡死自愈**：修「点朗读一直没声音、刷新无效、重启浏览器才恢复」的 Web Speech 引擎假死——①打断统一先 `resume()` 再 `cancel()`（paused 队列直接 cancel 无效，假死最常见成因）；②持有当前 Utterance 引用防 GC（无声且 onend 不触发的 Chrome 旧 bug）；③起播看门狗：3s 无 onstart 自动 cancel 重试本句一次，仍失败提示重启浏览器；④onend 丢失时按文本长度估时自动放行下一句，朗读链不中断

## 2026-10-27

- **PWA 发版不生效修复（Cloudflare CDN + NAS nginx）**：根因是 /reader 静态文件由 NAS nginx 直接服务且从不发 Cache-Control，Cloudflare 默认按扩展名缓存 js——sw.js 被边缘缓存旧版后，浏览器每次导航都拿不到新 SW，更新检测永不触发，index.html 被 SW precache（NavigationRoute）一直供旧页。修复：nginx 按 `/reader/assets/*`（内容 hash，一年 immutable）与 sw.js/index.html/manifest/workbox（no-cache）分层发缓存头（配置见 design.md §9）；后端 `cacheStatic`/`noStore` 兜底（/api、/auth 及网关别名 no-store）。**发版后需在 CF 清一次缓存（至少 /reader/sw.js），此后不会再犯**

- **账号体系扩展**：users 表加 nickname/avatar 列（存量库自动补列）；新增 `PUT /auth/profile`（昵称/头像，头像为前端 canvas 压缩的 128px dataURL，≤300KB）与 `PUT /auth/password`（验旧密码改新）；`/auth/me` 返回昵称与头像
- **书架页**：右上角账号区——未登录显示「登录」按钮，登录后显示头像圆钮，下拉含昵称/设置/退出登录；移出书架支持**长按**（移动端无右键），长按后吞 click 不误进详情；书架列表加加载中状态
- **账号设置页（/settings）**：上传头像（本地 128×128 方裁压缩预览）、改昵称、改密码；保存后书架头像即时刷新
- **书籍详情页**：开始阅读/移出书架/检查更新三按钮一排放卡片下方（左图右文结构不变）；缓存信息与缓存全本/停止/释放移到页面右上角；目录**分页每页 100 章**（首次载入定位到「上次读到」所在页），并加目录加载中状态
- **阅读器点透修复**：目录/换源/设置弹层的关闭按钮改用 `SheetClose`（touchend preventDefault 吞合成 click），修掉移动端点「×」误触发下方章节跳转的 bug；滚动收尾（位移>10px）不当作点按
- **搜索页**：`← 书架` 移到左侧；输入框加 × 清空；输入框字号改 16px（text-base）修掉 iOS 聚焦时页面放大；登录/设置页输入框同步 16px
- **阅读器目录居中定位**：打开目录弹层时把当前章自动滚到列表竖直中央（用容器与行的 rect 差值算 `scrollTop`，不用 `scrollIntoView`，避免连带滚动正文阅读位置）；目录异步到达后再定位一次；当前章行加 amber 淡底 + 中等字重，居中后仍能一眼锁定
- **刷新本章旋转动画**：强制刷新（`?refresh=1`）请求期间图标匀速旋转并禁用重复点击，返回即停；旋转施加在图标 `<span>` 上，按钮位置不跳
- **设计文档**：第四部分新增 §9「目录弹层定位与操作动效」（含点透修复模式），§8 目录条目同步指向；第一部分认证/数据模型/前端页面章节随账号体系与页面改版更新

## 2026-10-26

- **调试面板实时化**：调搜索/调书籍统一走一条 SSE 流；底层日志（浏览器启动、人机验证等待、脚本源 `log()`）经 `runWithLogSink` 实时并入；3s 无事件推 `tick` 心跳，前端显示「运行中 · Ns」；SSE 响应加 `X-Accel-Buffering: no`（反代不再缓冲）。此前浏览器启动等长耗时步骤完全没有日志，表现为「等很久然后一次性刷出来」
- **调书籍显示作者/封面**：详情一解析完就推 `bookinfo` 事件（不再等目录+正文跑完），右侧渲染书籍卡片（封面/书名/作者/最新章/简介）；取不到时标「未取到」并提示对应规则名，不再只看到「佚名」
- **API 网关前缀**：前端所有请求统一加 `/gw/reader` 前缀（`api.ts` 的 `API_BASE`，可用 `VITE_API_BASE` 覆盖，置空串直连同源 `/api`）；vite dev 代理 `/gw/reader` → `http://192.168.1.124`（路径原样保留，网关不剥前缀）；后端补 `/gw/reader/api`、`/gw/reader/auth` 别名路由（与 `/api`、`/auth` 等价，网关直接转发也能命中）
- **书架排序 tab**：默认「最近阅读」（按进度更新时间降序），可切「最近更新」（按书籍内容更新时间降序，卡片显示更新日期）；新增 `books.updated_at` 列（首次建目录 / 检查更新发现新章节时写入），存量库启动时自动补列并回填
- **书籍详情页**：封面垂直居中；「检查更新」按钮移到作者名右侧（缓存条只留缓存操作）
- **阅读器**：设置图标改齿轮；发音人列表只列中文（非中文旧设置自动清除）；上一章/下一章/目录跳章改用 `replace` 导航（返回键回书籍详情，不再退成上一章）；朗读从当前阅读位置起读，读完自动续读下一章

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
