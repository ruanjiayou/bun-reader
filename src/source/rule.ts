import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

// —— 规则语法 v2（链式调用版）——
// 规则 = ['CSS选择器'][.链式调用...] + 可选 ##正则##替换##变换 + 可选 || 回退
// 选择器：cheerio 支持的 CSS —— '#id' / '.class' / 'a.content' / 'div.main div.content' / ':eq(N)'
//   选择器建议用引号包裹（'h1'.text()），引擎也接受裸写 h1.text()
//   :eq(N) 是 cheerio 原生伪类，直接透传；从根查询的全局上下文里语义=整个结果集的第 N 个（≡ .eq(N)）
// 链式调用（永远在末尾，.xxx(...) 风格）。取值核心就两个：.text() 和 .attr('name')，
// 其余（.ownText() .textNodes() .html() .all() 及 find/children/eq/first/last/parent/next/prev 导航）是辅助：
//   取值：.text() .ownText() .textNodes() .html() .all() .attr('name')
//   导航：.find('sel') .children() .eq(n) .first() .last() .parent() .next() .prev()
//   .eq(n)/.first()/.last() 语义=整个结果集的全局索引（与 :eq 的逐容器语义不同）
// 无选择器 = 相对当前节点：章节列表项上直接 .attr('href') ≡ $(node).attr('href')，
//            .find('a').attr('href') ≡ $(node).find('a').attr('href')
// 保留：|| 回退、##正则##替换##变换（urlDecode/base64Decode）、{{bookUrl}}/{{baseUrl}} 模板、
//       JsonPath（$ 开头）、目录 {page} 模板（engine 层）

// 规则求值上下文：html 节点（cheerio）或 json 值（API 类书源）
export type Node = { kind: "html"; $: CheerioAPI; el: AnyNode } | { kind: "json"; v: any };

export function htmlNodes(text: string): Node[] {
  const $ = cheerio.load(text);
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
const CONTENT_CALLS: Record<string, string> = { text: ".text()", textNodes: ".textNodes()", ownText: ".ownText()", html: ".html()", all: ".all()" };
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
const CALL_NAMES = "text|textNodes|ownText|html|all|attr|find|children|eq|first|last|parent|next|prev";
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
// text.x（按文字找元素）无 CSS 等价，原样保留（求值为空）
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
function convertMain(main: string): string {
  main = main.trim();
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

export function legadoToOurs(rule: string): string {
  if (!rule || !rule.trim()) return rule;
  return rule
    .split("||")
    .map((part) => {
      const r = part.trim();
      if (!r || r.startsWith("$") || r.startsWith("{{") || r.includes("<js>")) return r;
      const h = r.indexOf("##");
      if (h > -1) return convertMain(r.slice(0, h)) + r.slice(h); // ## 后是正则/替换/变换，不动
      return convertMain(r);
    })
    .join("||");
}

const RULE_FIELDS = new Set(["bookList", "name", "author", "lastChapter", "intro", "coverUrl", "bookUrl", "tocUrl", "chapterList", "chapterName", "chapterUrl", "nextTocUrl", "content", "nextContentUrl"]);

// 书源 JSON 规则字段统一转换为 v2 语法（幂等，导入与运行前都调用）
export function normalizeSource(src: any): any {
  if (!src || typeof src !== "object") return src;
  const out = { ...src };
  for (const grp of ["ruleSearch", "ruleBookInfo", "ruleToc", "ruleContent"]) {
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

// 链式调用求值：导航调用产出元素，取值调用产出字符串（后续导航调用对字符串无效，自然终止）
function evalChain(cur: Node[], calls: Call[]): Node[] {
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
      case "attr": {
        const name = unquote(c.arg);
        for (const n of cur) if (n.kind === "html") next.push({ kind: "json", v: n.$(n.el).attr(name) ?? "" });
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
export function applyRule(input: Node[], rule: string, base = ""): Node[] {
  // 空规则返回空结果：缺失字段应得到 ""，而不是把整个元素文本当值
  if (!rule || !rule.trim()) return [];
  if (isJsRule(rule)) return []; // ponytail: JS 脚本源二期沙箱补
  if (rule.includes("||")) {
    for (const part of rule.split("||")) {
      const r = applyRule(input, part.trim(), base);
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
    try {
      regex = parts[0] ? new RegExp(parts[0], "g") : null;
    } catch {
      regex = null;
    }
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
      cur = evalChain(cur, calls);
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
export function ruleStr(nodes: Node[], rule: string, base = ""): string {
  return applyRule(nodes, rule, base)
    .map(nodeText)
    .filter(Boolean)
    .join("\n");
}

// 取列表：保留元素节点（html 元素或 json 对象）
export function ruleList(nodes: Node[], rule: string, base = ""): Node[] {
  return applyRule(nodes, rule, base);
}
