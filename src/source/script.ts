import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { runWithInst } from "./runtime";
import { isPlaceholder, type BookItem, type ChapterItem, type Log } from "./engine";

// —— 脚本书源引擎 ——
// 源 = export default class Source，方法 search/getDetail/getChapters/getContent（全可选），
// 配置为类成员 base/headers/replace。执行 = 落盘 + 动态 import（mtime 失效）+ Promise.race 超时。
// 契约见 docs/design.md（三、书源脚本引擎）。

const SOURCES_DIR = "data/sources";
const RUNTIME_URL = pathToFileURL(path.resolve(import.meta.dir, "runtime.ts")).href;
const DEFAULT_TIMEOUT = 30_000;
const TOC_TIMEOUT = 600_000; // 目录抓取放宽：加密翻页多屏 + 验证码人工验证最长 180s
const TOC_MAX_PAGES = 200;
const CONTENT_MAX_PAGES = 50;

// 保存脚本源：用户代码外面包一层 scaffold（注入 runtime import），落盘供动态 import
export function saveScriptFile(id: number, code: string) {
  mkdirSync(SOURCES_DIR, { recursive: true });
  const scaffold =
    `// AUTO SCAFFOLD —— 由引擎生成，请勿修改本段\n` +
    `import { fetchText, parse, abs, log, nodes, ruleText, ruleSel, browserOpen, browserText } from "${RUNTIME_URL}";\n\n`;
  writeFileSync(`${SOURCES_DIR}/${id}.js`, scaffold + code.trim() + "\n");
}

// —— 表单 → class 代码：表单给人看和编辑，生成的脚本是给程序执行的产物 ——

export interface ScriptForm {
  name?: string;
  base?: string;
  headers?: Record<string, string>;
  replace?: { regex: string; replacement: string }[];
  methods?: Partial<Record<"search" | "getDetail" | "getChapters" | "getContent", string>>;
}

const METHOD_NAMES = ["search", "getDetail", "getChapters", "getContent"] as const;

// headers 容错归一：字符串形态（规则源 header）解析成对象；解析失败或非对象返回 null
export function normalizeHeaders(h: unknown): Record<string, string> | null {
  if (!h) return null;
  if (typeof h === "string") {
    try {
      const p = JSON.parse(h);
      return p && typeof p === "object" && !Array.isArray(p) ? p : null;
    } catch {
      return null;
    }
  }
  return typeof h === "object" && !Array.isArray(h) ? (h as Record<string, string>) : null;
}

// 方法体剥掉整行注释后只剩空壳（async xxx(...) {}）→ 视为未实现，不写入 class
function hasMethodImpl(name: string, body: string): boolean {
  const stripped = body
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("");
  const rest = stripped.replace(/\s+/g, "");
  if (!rest) return false;
  return !new RegExp(`^async${name}\\([^)]*\\)\\{\\}$`).test(rest);
}

// 表单数据合并拼接为 class 源码（与前端各方法模板无关，留空/空壳的方法自动省略）
// headers 兼容字符串形态（规则源 header 就是字符串，转换/旧数据可能带过来）：先解析成对象再生成，避免二次编码
export function formToCode(form: ScriptForm): string {
  const lines: string[] = ["export default class Source {"];
  if (form.base?.trim()) lines.push(`  base = ${JSON.stringify(form.base.trim())};`);
  const headers = normalizeHeaders((form as any).headers);
  if (headers && Object.keys(headers).length) lines.push(`  headers = ${JSON.stringify(headers)};`);
  if (form.replace?.length) lines.push(`  replace = ${JSON.stringify(form.replace)};`);
  for (const m of METHOD_NAMES) {
    const body = (form.methods?.[m] ?? "").trim();
    if (!body || !hasMethodImpl(m, body)) continue;
    lines.push("", body);
  }
  lines.push("}");
  return lines.join("\n");
}

// 保存前校验：scaffold + 生成代码可解析且 default 导出为 class
export async function validateScriptCode(code: string): Promise<string | null> {
  const scaffold = `import { fetchText, parse, abs, log, nodes, ruleText, ruleSel, browserOpen, browserText } from ${JSON.stringify(RUNTIME_URL)};\n\n`;
  try {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(scaffold + code).toString("base64")}`);
    if (typeof mod.default !== "function") return "必须导出 export default class Source";
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

// 加载实例：按文件 mtime 缓存；模块经 data: URL 直载（Windows 下动态 import 新落盘文件有目录缓存竞态）
const cache = new Map<number, { mtime: number; inst: any }>();

export async function loadInst(id: number): Promise<any> {
  const file = `${SOURCES_DIR}/${id}.js`;
  if (!existsSync(file)) throw new Error(`脚本源未落盘：${file}（保存书源时自动生成）`);
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(id);
  if (hit && hit.mtime === mtime) return hit.inst;
  const code = readFileSync(file, "utf-8");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const Source = mod.default;
  if (typeof Source !== "function") throw new Error("脚本源必须 export default class Source");
  const inst = new Source();
  cache.set(id, { mtime, inst });
  return inst;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const gate = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} 超时（${ms}ms，脚本源可能有死循环或阻塞请求）`)), ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    clearTimeout(timer!);
  }
}

const abs2 = (u: string, base = ""): string => {
  if (!u) return u;
  // 绝对地址原样返回（与旧引擎 ensureAbs 一致：new URL 会把 {} 编码成 %7Bpage%7D）
  if (/^(https?:)?\/\//i.test(u)) return u;
  // 相对地址 + {page} 模板：手动补 origin，不走 URL 解析
  if (/\{\{?page\}?\}|%7[Bb]page%7[Dd]/.test(u)) {
    if (!base) return u;
    try {
      return new URL(base).origin + (u.startsWith("/") ? u : "/" + u);
    } catch {
      return u;
    }
  }
  try {
    return new URL(u, base || undefined).toString();
  } catch {
    return u;
  }
};

// 正文净化：先应用实例 replace 成员（{regex, replacement} 数组），再做通用清理（与规则引擎尾部一致）
function polish(text: string, inst: any): string {
  let t = text;
  const rr = inst?.replace;
  if (Array.isArray(rr)) {
    for (const r of rr) {
      if (typeof r?.regex !== "string" || !r.regex) continue;
      try {
        t = t.replace(new RegExp(r.regex, "g"), String(r.replacement ?? ""));
      } catch {
        // ponytail: 源里正则写坏了跳过不炸
      }
    }
  }
  return t
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function scriptSearch(row: { id: number }, key: string, log?: Log, timeoutMs = DEFAULT_TIMEOUT): Promise<BookItem[]> {
  const inst = await loadInst(row.id);
  if (typeof inst.search !== "function") return []; // 未实现搜索 = 该源不参与聚合
  log?.("info", "search", `脚本源搜索: ${key}`);
  const items = await withTimeout(runWithInst(inst, () => inst.search(key, 1)), timeoutMs, "search");
  if (!Array.isArray(items)) throw new Error("search 必须返回数组");
  const books = items
    .filter((b: any) => b && b.title && b.detailUrl)
    .map((b: any) => ({
      name: String(b.title),
      author: String(b.author ?? ""),
      bookUrl: abs2(String(b.detailUrl), inst.base),
      cover: abs2(String(b.cover ?? ""), inst.base),
      intro: String(b.desc ?? ""),
      latestChapter: "",
    }));
  log?.(books.length ? "ok" : "warn", "search", `脚本源命中 ${books.length} 条`);
  return books;
}

export async function scriptBookInfo(
  row: { id: number },
  url: string,
  log?: Log,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<{ name: string; author: string; intro: string; cover: string; latestChapter: string; latestChapterUrl: string; tocUrl: string }> {
  const inst = await loadInst(row.id);
  if (typeof inst.getDetail !== "function") throw new Error("该源未实现 getDetail");
  log?.("info", "book", `脚本源详情: ${url}`);
  const info = await withTimeout(runWithInst(inst, () => inst.getDetail(url)), timeoutMs, "getDetail");
  return {
    name: String(info?.title ?? ""),
    author: String(info?.author ?? ""),
    intro: String(info?.desc ?? ""),
    cover: abs2(String(info?.cover ?? ""), inst.base),
    latestChapter: "",
    latestChapterUrl: "",
    tocUrl: abs2(String(info?.tocUrl || url), inst.base || url),
  };
}

// 目录：源只返回当前页 {list, next}，翻页循环/防环/去重/上限都在引擎
export async function scriptToc(row: { id: number }, tocUrl: string, log?: Log, timeoutMs = DEFAULT_TIMEOUT): Promise<ChapterItem[]> {
  const inst = await loadInst(row.id);
  if (typeof inst.getChapters !== "function") throw new Error("该源未实现 getChapters");
  const chapters: ChapterItem[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  let url: string | null = tocUrl;
  let page = 0;
  while (url && page < TOC_MAX_PAGES) {
    if (visited.has(url)) {
      log?.("warn", "toc", `第 ${page + 1} 页地址已抓过（${url}），停止翻页`);
      break;
    }
    visited.add(url);
    page++;
    const cur: string = url;
    // 每页两条日志：SSE 调试面板能看到进度，同时充当连接心跳（长时间静默会被 idleTimeout 掐）
    log?.("info", "toc", page === 1 ? `目录: ${cur}` : `目录第 ${page} 页: ${cur}`);
    const r: any = await withTimeout(runWithInst(inst, () => inst.getChapters(cur)), TOC_TIMEOUT, "getChapters");
    const list = Array.isArray(r) ? r : (r?.list ?? []);
    for (const c of list ?? []) {
      const t = String(c?.title ?? "").trim();
      const u = abs2(String(c?.url ?? ""), inst.base);
      if (!t || !u || seen.has(u)) continue;
      seen.add(u);
      chapters.push({ title: t, url: u });
    }
    const next: string = Array.isArray(r) ? "" : String(r?.next ?? "");
    log?.("info", "toc", `第 ${page} 页 +${list.length} 章（新增 ${chapters.length} 累计）${next ? "，下一页 " + next : "，无下一页"}`);
    url = next ? abs2(next, inst.base) : null;
  }
  log?.(chapters.length ? "ok" : "warn", "toc", `脚本源目录：${chapters.length} 章 · ${page} 页`);
  return chapters;
}

// 正文：源返回 string（单页）或 {text, next}（章节内翻页），引擎循环拼接后统一净化
export async function scriptContent(row: { id: number }, chapterUrl: string, log?: Log, timeoutMs = DEFAULT_TIMEOUT): Promise<string> {
  const inst = await loadInst(row.id);
  if (typeof inst.getContent !== "function") throw new Error("该源未实现 getContent");
  const parts: string[] = [];
  const visited = new Set<string>();
  let url: string | null = chapterUrl;
  let page = 0;
  while (url && page < CONTENT_MAX_PAGES) {
    if (visited.has(url)) {
      log?.("warn", "content", `第 ${page + 1} 页地址已抓过，停止翻页`);
      break;
    }
    visited.add(url);
    page++;
    const cur: string = url;
    if (page > 1) log?.("info", "content", `正文第 ${page} 页: ${cur}`);
    const r: any = await withTimeout(runWithInst(inst, () => inst.getContent(cur)), timeoutMs, "getContent");
    const text = typeof r === "string" ? r : String(r?.text ?? "");
    if (!text.trim()) {
      if (page > 1) {
        log?.("warn", "content", `第 ${page} 页正文为空，返回已抓取的 ${page - 1} 页`);
        break;
      }
      throw new Error("正文为空");
    }
    parts.push(text);
    const next = typeof r === "string" ? "" : String(r?.next ?? "");
    url = next ? abs2(next, inst.base) : null;
  }
  const merged = polish(parts.join("\n"), inst);
  const ph = isPlaceholder(merged);
  log?.("ok", "content", `脚本源正文 ${merged.length} 字${page > 1 ? ` · ${page} 页` : ""}${ph ? " · ⚠️疑似占位内容" : ""}`);
  return merged;
}
