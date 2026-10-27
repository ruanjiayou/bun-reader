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
| `books` | id, user_id, book_url, source_id, name, author, cover, intro, latest_chapter, last_check_at | 书架；唯一约束 (user_id, book_url, source_id) |
| `chapters` | id, book_id, idx, title, url | 目录快照，加书架时抓取，按需刷新 |
| `chapter_cache` | content_key(sha1(book_url)), idx, file_path, size, is_placeholder, fetched_at | 正文索引；文件在 `data/cache/` |
| `cache_jobs` | content_key, total, done, failed, status, updated_at | 全本缓存后台任务进度（多用户共享） |
| `progress` | book_id, chapter_idx, scroll_pos, updated_at | 随 book 按用户隔离 |
| `settings` | user_id, key, value | 阅读偏好 |

**正文落盘**：`data/cache/{sha1(book_url)}/{idx}.txt`。库只存元数据；同一本书不同用户天然共享缓存；清理即删目录。

**疑似占位章节判定**（双重规则，命中任一即标记）：

1. 正文字数 < 阈值（默认 50 字，可在设置中调整）
2. 正文命中占位关键词：内置默认词表（"更新中"、"稍后更新"、"章节内容稍后"、"审核中"、"暂未更新"、"购买后查看" 等），词表存 settings 表**可自行增删**

标记为疑似占位的章节：缓存照常落盘，阅读器刷新按钮提示"本章疑似占位内容，可尝试刷新获取最新"。

## 5. API 概要

- **书源**：`GET/POST/DELETE /sources`（URL 批量导入 / 粘贴 JSON / 文件上传）、`POST /sources/:id/test`（体检）、`POST /sources/:id/debug`（SSE 调试日志，`{bookUrl}` 调书籍 / `{mode:"search",key}` 调搜索）
- **搜索**：`GET /search?q=` — 并发扇出全部启用源（每源并发 1、间隔 300ms、总超时 15s），**SSE 流式返回**；前端按书名+作者聚合去重
- **书架**：`GET /books`、`POST /books`（秒回落库，目录后台异步补）、`DELETE /books/:id`
- **目录**：`GET /books/:id/category`（`?refresh=1` 强制刷新）
- **正文**：`GET /books/:id/content/:idx`（`?refresh=1` 绕过缓存重抓）
- **进度**：`PUT /books/:id/progress`
- **缓存**：`POST /books/:id/cache-all`（全本后台缓存）、停止/释放接口

## 6. 书源规则引擎

**书源 JSON 格式完全兼容 Legado**；引擎内部将 Legado 选择器语法翻译为 cheerio 调用（语法规范见第二部分）。

抓取管线：构造模板 URL（`{{key}}`）→ fetch（书源 headers 优先，默认浏览器 UA/Referer）→ 编码识别（GBK/GB2312 用 iconv-lite，默认 UTF-8）→ 规则提取 → 正文正则净化 → 落盘。

限流：搜索每源串行 + 300ms 间隔，超时 10s，失败不阻塞其他源。

## 7. 前端页面

| 路由 | 页面 | 要点 |
|---|---|---|
| `/` | 书架 | 手机 3 列网格 / 桌面列表；排序 tab（默认「最近阅读」，可切「最近更新」）。**右上角账号区**：未登录=登录按钮；已登录=头像圆钮（无头像显示首字）→ 下拉（昵称 / 设置 / 退出登录）。**移出书架 = 右键或长按 500ms**（移动端没有右键），长按触发后吞掉同一次 click 不进详情。列表有**加载中状态**（转圈 + 「书架加载中…」），请求未回不显示「空书架」 |
| `/search` | 搜索 | SSE 实时追加结果卡片，聚合去重。布局：`← 书架` 在左，输入框中间（**16px 字号防 iOS 聚焦缩放**，框内有 × 清空），搜索按钮在右。登录/设置页输入框同为 16px |
| `/book/:id` | 书籍详情 | 封面左（垂直居中）、信息右（结构不变）；**操作按钮一排在卡片下方**：开始阅读/继续阅读（主按钮）、移出书架、检查更新；**缓存信息 + 缓存全本/停止/释放 在页面右上角**（与 ← 书架同一行）；目录**分页每页 100 章**（正/倒序先排序再切片，首次载入定位到「上次读到」所在页，切排序回第 1 页），目录有加载中状态 |
| `/book/:id/read/:idx` | 阅读器 | 见第四部分 |
| `/settings` | 账号设置 | 头像（点击圆形选图，本地压缩预览，随「保存资料」提交）、昵称、修改密码（旧密码 + 新密码×2）；保存后通知 App 刷新 `/auth/me`，书架头像立即生效 |
| `/sources` | 书源管理 | 列表启停、导入、表单编辑、调试面板 |

### 调试面板（书源页右侧）

调搜索与调书籍都走**同一条 SSE 流**（`POST /sources/:id/debug`），日志边跑边到，绝不攒到最后一次性返回：

| 事件 | 含义 | 前端处理 |
|---|---|---|
| `{level,step,msg}` | 引擎/底层日志行 | 追加到日志区（info/ok/warn/err 四色） |
| `{step:"books",books}` | 搜索书单 | 渲染结果卡片（封面+书名+作者+最新章，书 URL 可点填入「调书籍」） |
| `{step:"bookinfo",info}` | 详情解析结果 | **详情一解析完就推**（不等目录正文），渲染书籍卡片：封面 / 书名 / 作者 / 最新章 / 简介；字段取不到时显式标「未取到」并提示对应规则名，避免只看到下游的「佚名」 |
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
- `:eq(N)` 语义：整个结果集的第 N 个（≡ `.eq(N)`，`.eq(n)` 方法保留）
- 链式调用清单：取值 `text/html/all/ownText/textNodes/textBlocks/attr('x')`；导航 `find('sel')/children/eq(n)/first/last/parent/next/prev`
- **`.textBlocks()`**：正文段落提取专用——取最内层块级元素文本（嵌套 p 去重）、`<br>` 视为换行、容器裸文本（广告行）跳过、按文档序 `\n` 连接；容器内**没有块级子元素**（整段正文只用 `<br/>` 分行 + `&nbsp;` 缩进的手机站，如肉书屋）时回退为容器自身文本。正文规则**不要用 `.text()`**（全部拼一行无换行）
- 保留：`||` 回退、`##正则##替换##变换`、`{{bookUrl}}/{{baseUrl}}` 模板、JsonPath（$ 开头）、目录 `{page}` 模板

## 兼容迁移（normalizeSource，导入与运行前幂等转换）

旧语法 → 新语法：
- 裸取值器 `text/href/src/...` → `.text()` / `.attr('href')` / ...
- `a@text` → `a.text()`；`#info a.0@href` → `#info.find('a').eq(0).attr('href')`
- `sel.N` 索引后缀 → `.eq(N)`（带数字类名如 `.item-2` 不误拆）
- `attr(x)` → `.attr(x)`；`tag(x)` → `x`；`children` → `.children()`
- Legado 关键字 class./tag./id. 照旧转换
- 已是新语法（末尾含方法调用）的规则原样返回（幂等）

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
| 翻页 | 引擎处理：`getChapters` 返回 `{list, next}` 引擎循环；`getContent` 可返回 `{text, next}` 引擎拼接 |
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
nodes(res.text); ruleText(ns, "'#article'.textBlocks()"); ruleSel(ns, "规则");
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
| `ruleContent.nextContentUrl` | getContent 返回 `{text, next}` |
| `replaceRegex` / `header` | class `replace` / `headers` 成员 |

测试断言：同 fixture 下生成脚本与规则引擎产出一致。

## 8. Playwright 浏览器抓取（browser.ts）

- `launchPersistentContext("data/browser-profile")`：cookie/localStorage 自动持久化，验证通过一次后续自动复用
- channel 探测：系统 Chrome → Edge → playwright chromium；`BROWSER_HEADLESS=1` 切无头（默认有头）
- WAF 判定（防误报）：标题命中（中文验证词 / captcha / waf / human verification）、「小页面(<4000) + 关键词」、或页面内嵌 Turnstile 特征（`challenges.cloudflare.com/turnstile` / `cf-turnstile` / `aegis_captcha_verify`）；挑战页轮询等待通过（30s 提示、180s 超时）
- **反自动化检测**（Cloudflare Turnstile 等）：启动参数必须带 `args:["--disable-blink-features=AutomationControlled"]` + `ignoreDefaultArgs:["--enable-automation"]`，否则 `navigator.webdriver=true` 被识别、挑战永远不通过（普通浏览器能过、自动化过不了的根因）；Turnstile 自动通过无需人工，图片验证码需窗口手动输入
- **cookie 不能替代浏览器**：部分 WAF（如 69shuba aegis）同时校验 TLS 指纹，提取 cookie 给服务端 fetch 仍 403 → 这类站点必须全链路走浏览器（fetchText 会自动合并浏览器同域 cookie，可作普通 WAF 站的加速路径，但不保证够用）
- `BrowserPage.fetch(url, opts)`：页内上下文 fetch（page.evaluate），自动带浏览器 cookie / 真实 TLS 指纹，**支持 POST**（WAF 站搜索表单用）；`page.content()` 有「导航中」竞态（safeContent 重试兜底）；残留 chrome 持 profile 锁需按 CommandLine 杀进程

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

- **顶栏**（点正文唤出）：左返回 icon + 右文字按钮（首页/书架/书源/目录）。
- **底栏**：`上一章 · 章节进度 · 下一章` 三项居中，**不放设置**。
- **左侧浮动组**：书籍详情、缓存下载。
- **右侧浮动组**：刷新本章、朗读、**设置**——设置入口统一在右侧按钮组。

### PC（>500px）

- **左栏**：首页/书架/书源/目录（icon+文字纵向排列）。
- **右栏**（靠底）：书籍详情、刷新、朗读、设置（纯 icon 圆钮）。
- **底栏**：`上一章 · 章节进度 · 下一章` 居中悬浮。

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

- 6 预设：暗色 / 羊皮纸 / 纯黑 / 星空蓝 / 护眼绿 / 柔和灰；自定义 = 颜色选择器 + 透明度滑条（20–100%）。
- 文字色按「颜色亮度 × 透明度」混合后的亮度自动选亮/暗，全部内联样式注入。
- 设置面板控件统一：半透明黑底 + 浅描边，暗色主题下按钮不与文字混色。
- 所有设置（字号/行距/主题/语速/发音人）实时持久化 localStorage（`reader-prefs`）。
- 设置入口 icon 为**齿轮**（Feather settings），右侧浮动按钮组。

## 6. 朗读（TTS）

- **从当前阅读位置开始**：以滚动位置为准，取「第一个底边还在视口内的段落」作为起始段（与底部细线进度同源），不是每次从本章开头。
- **按句链式朗读**：段落先切分句（`。！？!?…` 为界，句末引号/右括号跟随前句），逐句合成，语速 0.5–1.5。
- **正在朗读的句子高亮为黄色**：当前句文字色 amber（深色主题 `#fbbf24` / 亮色主题 `#b45309`）+ `amber-400/15` 淡底；段落按句渲染成 `<span>`，仅朗读中的那段拆分，其余段落保持纯文本（不增加 DOM 开销）。
- **跟读滚动**：当前句所在段落滚出视口才 `scrollTo`（提前量 48px、定位到视口 30% 处），用户手动滚动不被强行拽回。
- **读完自动续读下一章**：本章最后一句结束 → `replace` 导航到下一章 → 新章正文就绪后从第一段继续朗读；已是最后一章则提示「已读完本书最后一章」。
- 停止/读完/切章时清除高亮（`spoken = null`）。
- 切章 / 换源 / 卸载页面会打断朗读（`ttsStopped` 标志避免 cancel 触发的 onend 继续读旧章）。
- 发音人列表**只列中文**（`lang` 以 `zh` 开头），已保存的非中文发音人自动清除。

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
- **修法（`SheetClose` 组件，目录/换源/设置三个弹层共用）**：`touchend` 阶段 `preventDefault()` 吞掉合成 click 并直接关闭；`touchstart` 记录起点，手位移 >10px 视为滚动收尾不当作点按；桌面仍走 `onClick`。
- 通用教训：**移动端在 click 里同步卸载浮层，同一次点按的 click 可能落到卸载后露出的下层元素**——凡「关闭浮层」类按钮都要走这个模式，不要裸用 onClick。
