import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { compileRuleRegex } from "./regex";

// —— 规则语法 v2（链式调用版）——
// 规则 = ['CSS选择器'][.链式调用...] + 可选 ##正则##替换##变换 + 可选 || 回退
// 选择器：cheerio 支持的 CSS —— '#id' / '.class' / 'a.content' / 'div.main div.content' / ':eq(N)'
//   选择器建议用引号包裹（'h1'.text()），引擎也接受裸写 h1.text()
//   :eq(N) 与 .eq(N)/.first()/.last() 一样 = 整个结果集的全局索引（cheerio 1.2 实测单/多容器一致）
// 链式调用（永远在末尾，.xxx(...) 风格）。取值核心就两个：.text() 和 .attr('name')，
// 其余（.ownText() .textNodes() .textBlocks() .html() .all() 及 find/children/eq/first/last/parent/next/prev 导航）是辅助：
//   取值：.text() .ownText() .textNodes() .textBlocks() .html() .all() .attr('name')
//   后处理：.trim() 去两端空白；.trim('字面量') 再去两端该字面量（处理「简介：」「作者：」这类标签前缀）
//   导航：.find('sel') .children() .eq(n) .first() .last() .parent() .next() .prev()
// 导航链压缩（legadoToOurs 自动做，幂等）：.find('x') 并进选择器空格相接、.eq(n)/.first()/.last() 并成 :eq(n)，
//   整段引号包裹 —— p.eq(1).find('a').text() → 'p:eq(1) a'.text()；.itemtxt.find('p').eq(1).find('a').text() →
//   '.itemtxt p:eq(1) a'.text()。children/parent/next/prev 与取值调用不能并进选择器，断开后原样保留在链上；
//   相对链开头的 .eq/.first/.last（无选择器、作用在输入集本身）保持调用形态不压缩
// 无选择器 = 相对当前节点：章节列表项上直接 .attr('href') ≡ $(node).attr('href')，
//            .find('a').attr('href') ≡ $(node).find('a').attr('href')
// 保留：|| 回退、##正则##替换##变换（urlDecode/base64Decode）、{{bookUrl}}/{{baseUrl}} 模板、
//       JsonPath（$ 开头）、目录 {page} 模板（engine 层）

// 规则求值上下文：html 节点（cheerio）或 json 值（API 类书源）
export type Node = { kind: "html"; $: CheerioAPI; el: AnyNode } | { kind: "json"; v: any };

// 文档级清洗：这些标签的文本永远不该出现在任何字段里。
// 尤其 <script>：cheerio 的 .text() 会把脚本源码原样拼进正文（实测
// `正文<script>var ad="广告"</script>` → `正文var ad="广告"`），后面再厉害的正则也只能删残渣。
const DOC_DROP_TAGS = "script,style,iframe,noscript,template,object,embed,svg,canvas,video,audio,source,track,ins";

export function htmlNodes(text: string): Node[] {
  const $ = cheerio.load(text);
  $(DOC_DROP_TAGS).remove();
  return [{ kind: "html", $, el: $.root().get(0)! }];
}

export function jsonNodes(v: any): Node[] {
  return [{ kind: "json", v }];
}

export function guessNodes(text: string): Node[] {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return jsonNodes(JSON.parse(t));
    } catch {
      /* 按html处理 */
    }
  }
  return htmlNodes(text);
}

const isJsRule = (r: string) => r.includes("<js>") || r.startsWith("@js:") || r.startsWith("@JavaScript:");

// —— 旧语法 → v2 迁移（normalizeSource 在导入与运行前调用，幂等）——
// 裸取值器 text/href → .text()/.attr('href')；a@text → a.text()；sel.N → .eq(N)；
// attr(x) → .attr(x)；tag(x) → x；children → .children()；Legado 关键字 class./tag./id. 照旧
const CONTENT_CALLS: Record<string, string> = { text: ".text()", textNodes: ".textNodes()", textBlocks: ".textBlocks()", ownText: ".ownText()", html: ".html()", all: ".all()" };
const ATTR_KEYWORDS = new Set(["href", "src", "content", "value", "title", "alt"]);
// 标准 HTML 标签名：裸单词命中则按标签选择，否则视为属性名
const HTML_TAGS = new Set(
  ("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr").split(
    " ",
  ),
);
// 段尾整数索引标记（如 a.0 / a.-1）：截断后按结果集索引取
const IDX = /^(.+)\.(-?\d+)$/;
// 纯标签/类/id（可含连字符和数字，如 h1、.item-2、#grid-12）→ 不拆索引，避免误伤合法类名
const PLAIN_SEL = /^[.#]?[A-Za-z][A-Za-z0-9_-]*$/;
const CALL_NAMES = "text|textNodes|textBlocks|ownText|html|all|attr|find|children|eq|first|last|parent|next|prev|trim";
// 规则末尾已是 .xxx(...) 方法调用，或选择器整体引号包裹 → 判定为 v2 语法，转换器原样返回（幂等）
const ALREADY_V2 = new RegExp(`\\.(${CALL_NAMES})\\((?:[^()']|'[^']*'|"[^"]*")*\\)$`);
const FULLY_QUOTED = /^'[^']*'$|^"[^"]*"$/;

function isIdent(s: string) {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

// —— Legado 关键字 → CSS（仅导入时转换）：class.x → .x · tag.x → x · id.x → #x · tag.a.-1 → a.-1 ——
// text.x（按文字找元素）→ 最内层文本匹配选择器，见 textSelector
function convertSeg(seg: string): string {
  const kw = seg.match(/^(class|tag|id)\.([^@]+?)(?:\.(-?\d+))?$/);
  if (!kw) return seg;
  const [, type, arg, nth] = kw;
  if (type === "tag") return nth ? `${arg}.eq(${nth})` : arg;
  let sel: string;
  if (type === "class") sel = isIdent(arg) ? `.${arg}` : `[class~="${arg}"]`;
  else sel = isIdent(arg) ? `#${arg}` : `[id="${arg}"]`;
  return nth ? `${sel} ${arg}.eq(${nth})` : sel;
}

// Legado 的 text.xxx ≡ //*[text()="xxx"]（直接文本等于该值）。
// CSS 没有文本伪类，用 :contains 取「自身含该文本、子孙不再含」的最内层元素近似：
// <a>下一页</a> 命中 a 本身；<a><span>下一页</span></a> 命中 span（与 text() 的语义一致）。
// 不加 :not(:has(...)) 会连 body/html 一起命中，取 @href 时祖先的空值会污染结果。
// 文本里的引号/反斜杠会被 CSS 解析吃掉，这里直接剔除（"下一页" 这类词实际不会出现）
function textSelector(text: string): string {
  const q = `"${text.replace(/["\\]/g, "")}"`;
  return `*:contains(${q}):not(:has(*:contains(${q})))`;
}

// 单段（@分节的一段）→ 选择器 / 调用
function convertSegToStep(seg: string, first: boolean, sel: string, calls: string[]) {
  let s = seg;
  let idx: number | null = null;
  if (!PLAIN_SEL.test(s)) {
    const m = s.match(IDX);
    if (m) {
      s = m[1];
      idx = parseInt(m[2]);
    }
  }
  // text.下一页 / text.下一页.-1（索引已被上面剥掉）
  const txt = s.match(/^text\.(.+)$/);
  if (txt) s = textSelector(txt[1]);
  if (CONTENT_CALLS[s]) {
    calls.push(CONTENT_CALLS[s]);
    return;
  }
  if (s === "children") {
    calls.push(".children()");
    return;
  }
  if (ATTR_KEYWORDS.has(s)) {
    calls.push(`.attr('${s}')`);
    return;
  }
  const am = s.match(/^attr\((.+)\)$/);
  if (am) {
    calls.push(`.attr('${unquote(am[1])}')`);
    return;
  }
  const tm = s.match(/^tag\((.+)\)$/);
  if (tm) {
    s = unquote(tm[1]); // tag(x) 强制按标签选，绕过取值器关键字冲突
  } else {
    s = convertSeg(s);
    // 裸非标签单词 = 旧语义的属性名（首段或后续段都一样）
    if (isIdent(s) && !HTML_TAGS.has(s.toLowerCase())) {
      calls.push(`.attr('${s}')`);
      return;
    }
  }
  if (first && !sel && !calls.length) {
    sel = s;
    if (idx !== null) calls.push(`.eq(${idx})`);
  } else {
    calls.push(`.find('${s}')`);
    if (idx !== null) calls.push(`.eq(${idx})`);
  }
  return sel;
}

// 主段转换：## 之后的段不参与；已是 v2 的原样返回
// 例外：存量数据里 `text.xxx` 曾原样保留（求值为空），转换后存成 "text.下一页.attr('href')"，
// 这种「文本段 + 已是 v2 调用链」的写法要先把文本段替换掉，否则再 normalize 也修不回来。
const V2_TAIL = new RegExp(`^text\\.(.+?)\\.(?=(?:${CALL_NAMES})\\()`);
function convertMain(main: string): string {
  main = main.trim();
  const legacyText = main.match(V2_TAIL);
  if (legacyText) return textSelector(legacyText[1]) + main.slice(legacyText[0].length - 1);
  if (!main || main.startsWith("$") || main.startsWith("{{") || isJsRule(main) || ALREADY_V2.test(main) || FULLY_QUOTED.test(main)) return main;
  const segs = main.split("@").map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return main;
  let sel = "";
  const calls: string[] = [];
  segs.forEach((seg, i) => {
    sel = convertSegToStep(seg, i === 0, sel, calls) ?? sel;
  });
  return sel + calls.join("");
}

// —— v2 链压缩：导航调用并进选择器 ——
// .find('x') 用空格并进选择器、.eq(n)/.first()/.last() 并成 :eq(n)（0/-1），整段引号包裹：
//   p.eq(1).find('a').text() → 'p:eq(1) a'.text()；.itemtxt.find('p').eq(1).find('a').text() → '.itemtxt p:eq(1) a'.text()
// 可靠性依据：:eq(N) 与 .eq(N) 同为结果集全局索引（cheerio 1.2 实测单/多容器一致）；引擎按项求值
//（ruleStr([el],…) 单节点上下文），此时 find+eq 与选择器内 :eq 严格等价。
// 不可并入的调用（children/parent/next/prev/取值/trim）断开压缩、原样保留在链上；相对链开头的
// .eq/.first/.last（无选择器、作用在输入集本身）保持调用形态。幂等：压缩形态再跑不变形。
function compressChain(main: string): string {
  const raw = main.trim();
  if (!raw || raw.startsWith("$") || raw.startsWith("{{") || isJsRule(raw)) return main;
  const { sel: sel0, calls } = parseChain(raw);
  let sel = sel0;
  let consumed = 0;
  for (const c of calls) {
    if (c.name === "find") {
      const x = unquote(c.arg);
      if (!x || /['"]/.test(x)) break; // 段内含引号，拼进引号串会破，保持原链
      sel = sel ? `${sel} ${x}` : x;
      consumed++;
    } else if (c.name === "eq" || c.name === "first" || c.name === "last") {
      const n = c.name === "eq" ? parseInt(c.arg, 10) : c.name === "first" ? 0 : -1;
      if (!sel || Number.isNaN(n)) break;
      sel += `:eq(${n})`;
      consumed++;
    } else break;
  }
  if (!sel) return main;
  // 选择器整体引号包裹（优先单引号，含单引号时换双引号，两种都含则不改写）
  const quote = !sel.includes("'") ? "'" : !sel.includes('"') ? '"' : null;
  if (!quote) return main;
  return quote + sel + quote + calls.slice(consumed).map((c) => `.${c.name}(${c.arg})`).join("");
}

export function legadoToOurs(rule: string): string {
  if (!rule || !rule.trim()) return rule;
  return rule
    .split("||")
    .map((part) => {
      const r = part.trim();
      if (!r || r.startsWith("$") || r.startsWith("{{") || r.includes("<js>")) return r;
      const h = r.indexOf("##");
      if (h > -1) return compressChain(convertMain(r.slice(0, h))) + r.slice(h); // ## 后是正则/替换/变换，不动
      return compressChain(convertMain(r));
    })
    .join("||");
}

const RULE_FIELDS = new Set(["bookList", "name", "author", "lastChapter", "intro", "coverUrl", "bookUrl", "tocUrl", "chapterList", "chapterName", "chapterUrl", "nextTocUrl", "content", "nextContentUrl"]);

// header 宽松解析：标准 JSON 失败时截取首个平衡的 {...} 对象（容错 devtools「Copy as fetch」复制出来的片段）。
// 本项目 header 统一以对象存储（legado 的字符串约定在导入时解析掉），运行期 parseHeader 不再做字符串兼容
function parseHeaderLoose(s: string): Record<string, string> | null {
  const tryParse = (t: string) => {
    try {
      const v = JSON.parse(t);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(s);
  if (direct) return direct;
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (!depth) return tryParse(s.slice(start, i + 1));
    }
  }
  return null;
}

// 书源 JSON 规则字段统一转换为 v2 语法（幂等，导入与运行前都调用）；header 统一对象化
export function normalizeSource(src: any): any {
  if (!src || typeof src !== "object") return src;
  const out = { ...src };
  if (typeof out.header === "string") {
    const h = parseHeaderLoose(out.header);
    if (h) out.header = h;
  }
  for (const grp of ["ruleSearch", "ruleExplore", "ruleBookInfo", "ruleToc", "ruleContent"]) {
    if (out[grp] && typeof out[grp] === "object")
      out[grp] = Object.fromEntries(
        Object.entries(out[grp]).map(([k, v]) => [k, typeof v === "string" && RULE_FIELDS.has(k) ? legadoToOurs(v) : v]),
      );
  }
  return out;
}

// —— v2 求值器 ——

function ownText($: CheerioAPI, el: AnyNode): string {
  let t = "";
  $(el)
    .contents()
    .each((_, c) => {
      if (c.type === "text") t += c.data ?? "";
    });
  return t.trim();
}

function textNodes($: CheerioAPI, el: AnyNode): string {
  const parts: string[] = [];
  $(el)
    .contents()
    .each((_, c) => {
      if (c.type === "text" && (c.data ?? "").trim()) parts.push((c.data as string).trim());
    });
  return parts.join("\n");
}

const BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th,section,article";

// 隐藏节点：站点常把广告/重复正文藏在 display:none 里，读者看不见但 .text() 照抓
const HIDDEN_SEL = '[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"]';
const SENTENCE_END = /[。！？…”」』；;，,]$/;
const JUNK_BLOCK_MAX = 12; // 「最新章节」这类推广块的字符上限

// 源级「额外要删的标签」（ruleContent.dropTags，逗号/空格/中文逗号分隔）。
// 只接受合法标签名：用户随手写 "</div>"、"#content" 之类会把选择器拼坏，宁可忽略也不要抛错——
// 这是调试期最容易踩的坑（规则看着生效了，其实整个清洗都在用坏选择器）。
export function parseDropTags(s?: string): string {
  if (!s) return "";
  return s
    .split(/[,，\s]+/)
    .map((t) => t.trim().toLowerCase().replace(/^<|>$/g, ""))
    .filter((t) => /^[a-z][a-z0-9-]*$/.test(t) && !DOC_DROP_TAGS.split(",").includes(t))
    .join(",");
}

// 正文容器级清洗（只在 .textBlocks() 上做，不影响标题/目录等字段的取值）：
//   · 删 script/style/iframe/noscript/ins/svg/video…（DOC_DROP_TAGS，cheerio 的 .text() 会把脚本源码拼进正文）
//   · 删隐藏节点（display:none / visibility:hidden / [hidden]，读者看不见但 .text() 照抓）
//   · 删「只含链接 + 短文本 + 不是句子」的块（正文里塞的「最新章节」「下载APP」「点击继续阅读」）
//   · 删空块；<a> 见下面单独处理
// 在独立 clone 上做，同一份文档还要取别的字段，不能就地改树。
// extra：源级追加要删的标签（ruleContent.dropTags），已经过 parseDropTags 规整
function sanitizeContainer($: CheerioAPI, el: AnyNode, extra = ""): { $: CheerioAPI; el: AnyNode } {
  const clone = cheerio.load($.html(el) ?? "");
  const $c = clone;
  const $root = $c.root();
  $root.find(DOC_DROP_TAGS).remove();
  if (extra) $root.find(extra).remove();
  $root.find(HIDDEN_SEL).remove();
  $root.find(BLOCK_SEL).each((_, n) => {
    const $n = $c(n);
    if ($n.find(BLOCK_SEL).length) return; // 容器块，由子块各自判定
    const t = $n.text().replace(/[\s\u00a0\u3000]+/g, "");
    if (!t) {
      $n.remove();
      return;
    }
    if ($n.find("a").length && t.length <= JUNK_BLOCK_MAX && !SENTENCE_END.test(t)) $n.remove();
  });
  // 残留的 <a>：独占一块的短链接（广告词、报错、TOP↑）整个删掉；夹在散文里的只解包保留文字。
  // 「独占」用父节点纯文本是否等于链接文字判断——正文里只有广告才会被一个链接占满整段，
  // 而万一站点把整段正文包在 <a> 里（个别反爬站这么干），长文本走解包分支，一个字都不会丢。
  $root.find("a").each((_, a) => {
    const $a = $c(a);
    const t = $a.text().replace(/[\s\u00a0\u3000]+/g, "");
    const alone = $a.parent().text().replace(/[\s\u00a0\u3000]+/g, "") === t;
    if (alone && t.length <= JUNK_BLOCK_MAX) $a.remove();
    else $a.replaceWith($a.contents());
  });
  return { $: $c, el: $root.get(0)! };
}

// 段落级正文提取：取最内层块级元素的文本（内部还嵌套块的容器跳过，避免嵌套 p 重复），<br> 视为换行，按文档序 \n 连接
// 对比 .text()（全部拼一行无换行）和 .textNodes()（只取直接文本节点）：正文场景两者都不对，这个才是想要的
// 容器内没有块级子元素（整段正文只用 <br> 分行，如肉书屋/部分手机站）时回退为容器自身文本
// sanitize=false 时退回旧行为（源上配 ruleContent.stripTags=false，个别站点正文就藏在隐藏节点里）
function textBlocks($: CheerioAPI, el: AnyNode, sanitize = true, extraDrop = ""): string {
  let $c = $;
  let root = el;
  if (sanitize) ({ $: $c, el: root } = sanitizeContainer($, el, extraDrop));
  const out: string[] = [];
  const push = (n: AnyNode) => {
    const c = $c(n).clone();
    c.find("br").replaceWith("\n");
    for (const line of c.text().split("\n")) {
      const t = line.replace(/[ \t\u00a0\u3000]+/g, " ").trim(); // \u00a0 = &nbsp;，手机站正文首行全靠它缩进
      if (t) out.push(t);
    }
  };
  $c(root)
    .find(BLOCK_SEL)
    .each((_, n) => {
      if ($c(n).find(BLOCK_SEL).length) return; // 容器块：子块会各自产出
      push(n);
    });
  if (!out.length) push(root); // 无块级子元素：回退到容器自身的 <br> 分行文本
  return out.join("\n");
}

function safeFind($: CheerioAPI, el: AnyNode, sel: string): AnyNode[] {
  try {
    return $(el).find(sel).toArray();
  } catch {
    return [];
  }
}

type Call = { name: string; arg: string };

// 解析 ['选择器'][.调用...]：从末尾反复剥 .name(args)；选择器若整体引号包裹则去引号。
// :eq(N) 不做转换——cheerio 原生支持（语义=每个匹配上下文各自的第 N 个），直接透传给 find
function parseChain(main: string): { sel: string; calls: Call[] } {
  const calls: Call[] = [];
  let s = main.trim();
  for (;;) {
    const m = s.match(new RegExp(`\\.(${CALL_NAMES})\\(((?:[^()']|'[^']*'|"[^"]*")*)\\)$`));
    if (!m) break;
    calls.unshift({ name: m[1], arg: m[2].trim() });
    s = s.slice(0, m.index).trim();
  }
  // 选择器引号包裹：'h1'.text() / ".intro a".attr('href') —— 引号不属于选择器本身
  const qm = s.match(/^'([^']*)'$|^"([^"]*)"$/);
  if (qm) s = qm[1] ?? qm[2];
  return { sel: s, calls };
}

// 规则求值选项（目前只有正文净化相关的开关；默认全开）
export interface EvalOpts {
  sanitize?: boolean; // .textBlocks() 是否做容器级清洗（删隐藏节点/短链接块、解包 a）
  dropTags?: string; // 额外要删的标签（连同内容），逗号分隔；见 parseDropTags
}

// —— 正文规则默认取值 ——
// 正文规则的写法就应该是「选择器」：'.articlebody' / '#content' / '.readcontent'。
// 选到节点之后怎么取文本不该让用户操心：引擎固定走「结构清洗（删 script/a/隐藏节点）→ 按块分段」，
// 也就是 .textBlocks() 的那一套。用户以前必须写 '.articlebody'.textBlocks()，忘了写就整章压成一行
// （.text() 的默认语义），排查起来极难看出是规则漏了尾巴。
// 所以：链上没有任何取值调用时，自动补 .textBlocks()；显式写了 .text()/.html()/.textNodes() 的保持原样。
const VALUE_CALLS = new Set(["text", "textNodes", "textBlocks", "ownText", "html", "all", "attr", "trim"]);

export function contentRule(rule: string): string {
  if (!rule || !rule.trim()) return rule;
  return rule
    .split("||")
    .map((part) => {
      const raw = part.trim();
      if (!raw) return part;
      const hash = raw.indexOf("##"); // ##正则## 后处理段不属于选择器，补调用要插在它前面
      const main = (hash > -1 ? raw.slice(0, hash) : raw).trim();
      const rest = hash > -1 ? raw.slice(hash) : "";
      if (!main) return part;
      if (main.startsWith("$") || /^\{\{/.test(main)) return part; // JsonPath / URL 模板：不是 DOM 选择
      const { calls } = parseChain(main);
      if (calls.some((c) => VALUE_CALLS.has(c.name))) return part;
      return `${main}.textBlocks()${rest}`;
    })
    .join("||");
}

// 链式调用求值：导航调用产出元素，取值调用产出字符串（后续导航调用对字符串无效，自然终止）
function evalChain(cur: Node[], calls: Call[], opts?: EvalOpts): Node[] {
  for (const c of calls) {
    const next: Node[] = [];
    switch (c.name) {
      case "find": {
        const sel = unquote(c.arg);
        for (const n of cur) if (n.kind === "html") safeFind(n.$, n.el, sel).forEach((e) => next.push({ kind: "html", $: n.$, el: e }));
        break;
      }
      case "children":
        for (const n of cur) if (n.kind === "html") n.$(n.el).children().toArray().forEach((e) => next.push({ kind: "html", $: n.$, el: e }));
        break;
      case "parent":
        for (const n of cur)
          if (n.kind === "html") {
            const p = n.$(n.el).parent().get(0);
            if (p) next.push({ kind: "html", $: n.$, el: p });
          }
        break;
      case "next":
      case "prev":
        for (const n of cur)
          if (n.kind === "html") {
            const e = (c.name === "next" ? n.$(n.el).next() : n.$(n.el).prev()).get(0);
            if (e) next.push({ kind: "html", $: n.$, el: e });
          }
        break;
      case "eq": {
        const i = parseInt(c.arg, 10);
        const el = Number.isNaN(i) ? undefined : cur[i >= 0 ? i : cur.length + i];
        if (el) next.push(el); // 收窄结果集，链上后续调用继续（不能 return 短路）
        break;
      }
      case "first":
        if (cur[0]) next.push(cur[0]);
        break;
      case "last":
        if (cur.length) next.push(cur[cur.length - 1]);
        break;
      case "text":
        for (const n of cur) if (n.kind === "html") next.push({ kind: "json", v: n.$(n.el).text().trim() });
        break;
      case "html":
        for (const n of cur) if (n.kind === "html") next.push({ kind: "json", v: n.$(n.el).html() ?? "" });
        break;
      case "all":
        for (const n of cur) if (n.kind === "html") next.push({ kind: "json", v: n.$.html(n.el) });
        break;
      case "ownText":
        for (const n of cur) if (n.kind === "html") next.push({ kind: "json", v: ownText(n.$, n.el) });
        break;
      case "textNodes":
        for (const n of cur) if (n.kind === "html") next.push({ kind: "json", v: textNodes(n.$, n.el) });
        break;
      case "textBlocks":
        for (const n of cur)
          if (n.kind === "html") next.push({ kind: "json", v: textBlocks(n.$, n.el, opts?.sanitize !== false, parseDropTags(opts?.dropTags)) });
        break;
      case "attr": {
        const name = unquote(c.arg);
        for (const n of cur) {
          if (n.kind !== "html") continue;
          let v = n.$(n.el).attr(name) ?? "";
          // 文本匹配（text.下一页）常命中 <a><span>下一页</span></a> 里的内层元素：
          // 自身没有链接属性就向上取最近带该属性的祖先，否则 text.xxx@href 在包一层的站点上取不到地址
          if (!v && name === "href") {
            const anc = n.$(n.el).parents("[href]").first();
            if (anc.length) v = anc.attr("href") ?? "";
          }
          next.push({ kind: "json", v });
        }
        break;
      }
      case "trim": {
        // 取值后处理：无参 = 去两端空白；.trim('字面量') = 再去两端该字面量（「简介：」「作者：」标签前缀）。
        // 只作用于字符串值（.text()/.attr() 等取值调用之后）；元素节点原样放行
        const lit = unquote(c.arg);
        for (const n of cur) {
          if (n.kind !== "json" || typeof n.v !== "string") {
            next.push(n);
            continue;
          }
          let v = n.v.trim();
          if (lit) {
            if (v.startsWith(lit)) v = v.slice(lit.length).trim();
            if (v.endsWith(lit)) v = v.slice(0, -lit.length).trim();
          }
          next.push({ kind: "json", v });
        }
        break;
      }
    }
    cur = next;
    if (!cur.length) break;
  }
  return cur;
}

// JsonPath 子集：$.a.b[0].c / [*] / 纯数字索引
function applyJsonPath(nodes: Node[], rule: string): Node[] {
  let cur: any[] = nodes.filter((n) => n.kind === "json").map((n) => (n as any).v);
  const tokens = rule.slice(1).match(/[^.[\]]+|\[\*\]|\[\d+\]/g) ?? [];
  for (const t of tokens) {
    if (t === "[*]") cur = cur.flatMap((v) => (Array.isArray(v) ? v : [v]));
    else if (/^\d+$/.test(t)) cur = cur.map((v) => (Array.isArray(v) ? v[+t] : v)).filter((v) => v != null);
    else
      cur = cur.flatMap((v) => {
        if (v == null) return [];
        if (Array.isArray(v)) return v.map((x) => x?.[t]).filter((x) => x != null);
        return v[t] !== undefined ? [v[t]] : [];
      });
  }
  return cur.map((v) => ({ kind: "json", v }));
}

// 规则求值主入口：支持 ##regex##replace 后处理、|| 回退；JS 脚本规则不支持（返回空）
export function applyRule(input: Node[], rule: string, base = "", opts?: EvalOpts): Node[] {
  // 空规则返回空结果：缺失字段应得到 ""，而不是把整个元素文本当值
  if (!rule || !rule.trim()) return [];
  if (isJsRule(rule)) return []; // ponytail: JS 脚本源二期沙箱补
  if (rule.includes("||")) {
    for (const part of rule.split("||")) {
      const r = applyRule(input, part.trim(), base, opts);
      if (r.length) return r;
    }
    return [];
  }
  let main = rule.trim();
  let regex: RegExp | null = null;
  let rep = "";
  let xf = "";
  const hash = main.indexOf("##");
  if (hash > -1) {
    const parts = main.slice(hash + 2).split("##");
    main = main.slice(0, hash);
    // 走统一编译：默认不区分大小写，并兼容 Java 的 (?i) 写法（JS 直接 new RegExp("(?i)…") 会抛错）
    regex = parts[0] ? compileRuleRegex(parts[0]) : null;
    rep = parts[1] ?? "";
    xf = parts[2] ?? ""; // 第三段：变换函数（逗号分隔按序执行）
    // 无正则时（####变换）第二段就是变换函数，避免被当成替换文本
    if (!parts[0] && !xf && /^(urlDecode|base64Decode)(,|$)/.test(rep)) {
      xf = rep;
      rep = "";
    }
  }
  let cur: Node[] = input;
  if (main) {
    if (main.startsWith("$")) cur = applyJsonPath(cur, main);
    // URL 模板段：{{bookUrl}}/{{baseUrl}} 产出当前页地址，配合 ## 正则实现固定格式跳转
    else if (/^\{\{(?:baseUrl|bookUrl)\}\}$/.test(main)) cur = [{ kind: "json", v: base }];
    else {
      const { sel, calls } = parseChain(main);
      if (sel) {
        const next: Node[] = [];
        for (const n of cur) if (n.kind === "html") safeFind(n.$, n.el, sel).forEach((e) => next.push({ kind: "html", $: n.$, el: e }));
        cur = next;
      }
      cur = evalChain(cur, calls, opts);
    }
  }
  if (regex) cur = cur.map((n) => ({ kind: "json", v: nodeText(n).replace(regex!, rep) }));
  // 变换段：##正则##替换##urlDecode,base64Decode —— 处理站点把真实地址藏在
  // onclick 里做 base64 跳转参数的情况（如 ?action=go&t=aHR0cHM6...%3D）
  if (xf) {
    for (const t of xf.split(",").map((s) => s.trim()).filter(Boolean)) {
      cur = cur.map((n) => {
        let v = nodeText(n);
        try {
          if (t === "urlDecode") v = decodeURIComponent(v);
          else if (t === "base64Decode") {
            const s = v.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
            v = Buffer.from(s, "base64").toString("utf-8");
          }
        } catch {
          /* 解码失败保留原值 */
        }
        return { kind: "json", v };
      });
    }
  }
  return cur;
}

export function nodeText(n: Node): string {
  if (n.kind === "html") return n.$(n.el).text().trim();
  const v = n.v;
  return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
}

// 取字符串：多结果按 Legado 习惯用 \n 连接
export function ruleStr(nodes: Node[], rule: string, base = "", opts?: EvalOpts): string {
  return applyRule(nodes, rule, base, opts)
    .map(nodeText)
    .filter(Boolean)
    .join("\n");
}

// 取列表：保留元素节点（html 元素或 json 对象）
export function ruleList(nodes: Node[], rule: string, base = "", opts?: EvalOpts): Node[] {
  return applyRule(nodes, rule, base, opts);
}
