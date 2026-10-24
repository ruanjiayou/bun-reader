import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

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

// —— 规则文法（本项目规范，写源时按此定义）——
// 规则 = 段1@段2@…##正则##替换##变换，@ 分段，每段二选一：
// 1. 选择器（产出元素）：CSS —— tag / #id / .class / 组合(div.intro) / 层级(空格、>) / 段尾索引(a.-1)
//    显式形式 tag(name)：name 与取值器关键字冲突时强制按标签选（如 tag(title) 选 <title> 元素）
// 2. 取值器（产出字符串）：
//    内容值：text（全文）/ ownText（仅直属文本）/ textNodes（直属文本块）/ html（innerHTML）/ all（outerHTML）
//    属性值：attr(name) —— 任意属性，显式无歧义（如 attr(data-url)、attr(title)）
//            href / src 为常用属性快捷方式（自动补全绝对地址）；title/alt/content/value 兼容裸写
//            其他裸单词：是标准标签名→按标签选择；否则兜底按属性名取（如 data-src）
// 章节类规则（chapterName/chapterUrl 等）在 chapterList 选中的每个元素内部求值：
//    chapterName: "text" 取 <a> 文本；"attr(title)" 取 title 属性；".t@text" 取内部 <span class=t> 的文本
// —— Legado 关键字 → 本项目 CSS 语法（仅导入时转换，求值器不认关键字）——

const GETTERS = /^(text|textNodes|ownText|html|all|href|src|content|value|title|alt)$/;
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

function isIdent(s: string) {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

// —— Legado 关键字 → 本项目 CSS 语法（仅导入时转换，求值器不认关键字）——
// class.x → .x · tag.x → x · id.x → #x · 索引 tag.a.-1 → a.-1；text.x（按文字找元素）无 CSS 等价，原样保留（求值为空）
function convertSeg(seg: string): string {
  const kw = seg.match(/^(class|tag|id)\.([^@]+?)(?:\.(-?\d+))?$/);
  if (!kw) return seg;
  const [, type, arg, nth] = kw;
  let sel: string;
  if (type === "class") sel = isIdent(arg) ? `.${arg}` : `[class~="${arg}"]`;
  else if (type === "tag") sel = arg;
  else sel = isIdent(arg) ? `#${arg}` : `[id="${arg}"]`;
  return nth ? `${sel}.${nth}` : sel;
}

export function legadoToOurs(rule: string): string {
  if (!rule || !rule.trim()) return rule;
  return rule
    .split("||")
    .map((part) => {
      const r = part.trim();
      // JsonPath / {{模板}} / JS 规则原样保留
      if (!r || r.startsWith("$") || r.startsWith("{{") || r.includes("<js>")) return r;
      return r
        .split("@")
        .map((s) => convertSeg(s.trim()))
        .join("@");
    })
    .join("||");
}

const RULE_FIELDS = new Set(["bookList", "name", "author", "lastChapter", "intro", "coverUrl", "bookUrl", "tocUrl", "chapterList", "chapterName", "chapterUrl", "nextTocUrl", "content", "nextContentUrl"]);

// 书源 JSON 规则字段统一转换为本项目语法（幂等，导入与运行前都调用）
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

function getter(g: string, $: CheerioAPI, el: AnyNode, base: string): string {
  switch (g) {
    case "text":
      return $(el).text().trim();
    case "ownText":
      return ownText($, el);
    case "textNodes":
      return textNodes($, el);
    case "html":
      return $(el).html() ?? "";
    case "all":
      return $.html(el);
    case "href":
    case "src": {
      const v = $(el).attr(g) ?? "";
      if (!v) return "";
      try {
        return new URL(v, base).toString();
      } catch {
        return v;
      }
    }
    default:
      return $(el).attr(g) ?? "";
  }
}

function safeFind($: CheerioAPI, el: AnyNode, sel: string): AnyNode[] {
  try {
    return $(el).find(sel).toArray();
  } catch {
    return [];
  }
}

const ATTR_FN = /^attr\((.+)\)$/; // attr(name)：显式取任意属性，无歧义
const TAG_FN = /^tag\((.+)\)$/; // tag(name)：显式按标签选元素（name 与取值器关键字冲突时用，如 tag(title)）

// 单段求值：CSS 选择器（#id/.class/tag 可组合）+ 取值器 + 段尾整数索引（a.-1）
function stepHtml(n: Extract<Node, { kind: "html" }>, raw: string, base: string, out: Node[]) {
  const { $, el } = n;
  const am = raw.match(ATTR_FN);
  if (am) {
    out.push({ kind: "json", v: $(el).attr(am[1]) ?? "" }); // 属性值原样返回，不做 URL 补全
    return;
  }
  const tm = raw.match(TAG_FN);
  if (tm) {
    safeFind($, el, tm[1]).forEach((c) => out.push({ kind: "html", $, el: c }));
    return;
  }
  if (GETTERS.test(raw)) {
    out.push({ kind: "json", v: getter(raw, $, el, base) });
    return;
  }
  if (raw === "children") {
    $(el)
      .children()
      .toArray()
      .forEach((c) => out.push({ kind: "html", $, el: c }));
    return;
  }
  let sel = raw;
  let idx: number | undefined;
  if (!PLAIN_SEL.test(raw)) {
    const m = raw.match(IDX);
    if (m) {
      sel = m[1];
      idx = parseInt(m[2]);
    }
  }
  let found: AnyNode[];
  if (isIdent(sel)) {
    if (HTML_TAGS.has(sel.toLowerCase())) found = safeFind($, el, sel); // 标签名
    else {
      out.push({ kind: "json", v: $(el).attr(sel) ?? "" }); // 属性名（如 data-src）
      return;
    }
  } else found = safeFind($, el, sel); // 其余整段 CSS 选择器
  if (idx !== undefined) found = [found[idx >= 0 ? idx : found.length + idx]].filter(Boolean);
  found.forEach((c) => out.push({ kind: "html", $, el: c }));
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
  if (isJsRule(rule)) return []; // ponytail: JS 脚本源 M2 不支持，二期沙箱补
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
    // URL 模板段：{{bookUrl}}/{{baseUrl}} 产出当前页地址，配合 ## 正则实现固定格式跳转（如 /book/1 → /chapter/1）
    else if (/^\{\{(?:baseUrl|bookUrl)\}\}$/.test(main)) cur = [{ kind: "json", v: base }];
    else {
      const segs = main.split("@");
      for (let i = 0; i < segs.length; i++) {
        const raw = segs[i].trim();
        if (!raw) continue;
        const next: Node[] = [];
        for (const n of cur) if (n.kind === "html") stepHtml(n, raw, base, next);
        cur = next;
        if (!cur.length) break;
      }
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
