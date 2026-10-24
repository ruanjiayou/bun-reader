# 书源规则语法 v2（链式调用版）

## 目标语法（用户拍板）

规则 = `[CSS选择器][.链式调用...]`，**去掉 @ 分节器**。

- 选择器：cheerio 支持的 CSS —— `'#id'` `'.class'` `'a.content'` `'div.main div.content'`，选第 N 个用 `:eq(2)`（cheerio 原生伪类，直接透传）
- **选择器建议用引号包裹**：`'h1'.text()`、`'.bookname a'.attr('href')`、`'.bb a:eq(1)'.attr('href')`——引号只是把选择器括起来，引擎解析时剥掉；裸写 `h1.text()` 同样有效
- 取值：`.xxx(...)` 函数调用风格，永远在规则末尾：
  - `'h1'.text()` → 引擎处理为 `$('h1').text()`
  - 章节地址：`'a'.attr('href')`，或列表项已是元素时直接 `.attr('href')`（≡ `$(node).attr('href')`）
  - 深层取值：`.find('a').attr('href')`（≡ `$(node).find('a').attr('href')`）
- `:eq(N)` 语义：从根查询的全局上下文里 = 整个结果集的第 N 个（≡ `.eq(N)`，`.eq(n)` 方法保留）
- 链式调用清单：取值 `text/html/all/ownText/textNodes/attr('x')`；导航 `find('sel')/children/eq(n)/first/last/parent/next/prev`
- 保留：`||` 回退、`##正则##替换##变换`、`{{bookUrl}}/{{baseUrl}}` 模板、JsonPath（$ 开头）、目录 `{page}` 模板

## 兼容迁移（normalizeSource，导入与运行前幂等转换）

旧语法 → 新语法：
- 裸取值器 `text/href/src/...` → `.text()` / `.attr('href')` / ...
- `a@text` → `a.text()`；`#info a.0@href` → `#info.find('a').eq(0).attr('href')`
- `sel.N` 索引后缀 → `.eq(N)`（带数字类名如 `.item-2` 不误拆）
- `attr(x)` → `.attr(x)`；`tag(x)` → `x`；`children` → `.children()`
- Legado 关键字 class./tag./id. 照旧转换
- 已是新语法（末尾含方法调用）的规则原样返回（幂等）

库内旧源（sto66、幽香书房）靠运行时 normalizeSource 自动兼容，无需改库。

## 引擎配套

- getToc 默认 chapterName `.text()`、chapterUrl `.attr('href')`
- getBookInfo 封面补 ensureAbs（旧取值器自动补绝对地址的行为移到引擎层）
- Sources 页表单示例提示全部换成新语法

## 验收

- 全部测试红→绿：新语法求值、迁移转换幂等、旧语法源经 normalizeSource 全链路可用
- tsc + Vite 构建通过
