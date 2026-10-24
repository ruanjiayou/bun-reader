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

const RULE_FIELDS = new Set(["bookList", "name", "author", "lastChapter", "intro", "coverUrl", "bookUrl", "tocUrl", "chapterList", "chapterName", "chapterUrl", "nextTocUrl", "content"]);

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

// 单段求值：CSS 选择器（#id/.class/tag 可组合）+ 取值器 + 段尾整数索引（a.-1）
function stepHtml(n: Extract<Node, { kind: "html" }>, raw: string, base: string, out: Node[]) {
  const { $, el } = n;
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
