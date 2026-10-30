import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { runWithInst } from "./runtime";
import { isPlaceholder, type BookItem, type ChapterItem, type Log } from "./engine";
import { log } from "../log";

// —— 脚本书源引擎 ——
// 源 = export default class Source，方法 search/getDetail/getChapters/getContent（全可选），
// 配置为类成员 base/headers/replace。执行 = 落盘 + 动态 import（mtime 失效）+ Promise.race 超时。
// 契约见 docs/design.md（三、书源脚本引擎）。

const SOURCES_DIR = "data/sources";

// 引擎调用方传进来的行：code 是生成脚本的主体（不含脚手架），文件丢了靠它重建
export interface ScriptRow {
  id: number;
  code?: string | null;
}

// 项目根（src/source 往上两级）。落盘脚本里的 import 一律只写「相对项目根」的路径，
// 绝不把本机绝对路径烧进数据文件 —— 否则 Windows 上存的源搬到 Linux 直接找不到模块。
const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME_SPEC = "../../src/source/runtime.ts";

// runtime.ts 在当前机器上的真实位置 → file:// URL（data: 模块里只能 import 绝对 URL）
const RUNTIME_URL = (() => {
  const candidates = [
    process.env.BUN_READER_RUNTIME,
    path.join(import.meta.dir, "runtime.ts"), // 常规：与本源同目录
    path.join(PROJECT_ROOT, "src/source/runtime.ts"), // 兜底：按项目根拼接（cwd/打包方式变化时）
  ].filter((p): p is string => !!p);
  const hit = candidates.find((p) => existsSync(p)) ?? candidates[0];
  return pathToFileURL(hit).href;
})();

// 脚手架 import 行：import { ... } from "<任意说明符>";
const SCAFFOLD_IMPORT_RE = /(^\s*import\s*\{[^}]*\}\s*from\s*)(["'])([^"']*)\2;/m;
// 健康文件的标志：说明符就是相对路径（文件本身机器无关）
const SPEC_MARK = `"${RUNTIME_SPEC}"`;
// 把说明符统一换成本机 RUNTIME_URL。data:URL 没有 base，相对 import 解析不了，必须改成绝对 file URL。
const withRuntime = (code: string): string =>
  code.replace(SCAFFOLD_IMPORT_RE, (_m, head: string) => `${head}"${RUNTIME_URL}";`);

const DEFAULT_TIMEOUT = 30_000;
const TOC_TIMEOUT = 600_000; // 目录抓取放宽：加密翻页多屏 + 验证码人工验证最长 180s
const TOC_MAX_PAGES = 200;
const CONTENT_MAX_PAGES = 50;

// 保存脚本源：用户代码外面包一层 scaffold（注入 runtime import），落盘供动态 import
export function saveScriptFile(id: number, code: string) {
  mkdirSync(SOURCES_DIR, { recursive: true });
  const scaffold =
    `// AUTO SCAFFOLD —— 由引擎生成，请勿修改本段\n` +
    `import { fetchText, parse, abs, log, nodes, ruleText, ruleSel, browserOpen, browserText } from "${RUNTIME_SPEC}";\n\n`;
  writeFileSync(`${SOURCES_DIR}/${id}.js`, scaffold + code.trim() + "\n");
}

// —— 落盘文件是产物，code 列才是真相 ——
// 部署机上 data/sources 常常不跟数据库一起同步（文件被清、换机器、只拷了 book.db），
// 所以文件缺失或头部不是相对路径时，直接按数据库的 code 重新生成，而不是修复旧文件。

async function dbParts() {
  const [{ db }, { sources }, { eq }] = await Promise.all([import("../db"), import("../schema"), import("drizzle-orm")]);
  return { db, sources, eq };
}

async function codeFromDb(id: number): Promise<string | null> {
  const { db, sources, eq } = await dbParts();
  const [row] = await db
    .select({ code: sources.code, type: sources.type })
    .from(sources)
    .where(eq(sources.id, id));
  if (!row || row.type !== "script") return null; // 规则源不落盘脚本，走规则引擎
  return row.code?.trim() || null;
}

// 确保 data/sources/{id}.js 存在且是「相对路径」格式；否则按 code 重新生成。返回文件路径。
export async function ensureScriptFile(id: number, code?: string | null): Promise<string> {
  const file = `${SOURCES_DIR}/${id}.js`;
  if (existsSync(file) && readFileSync(file, "utf-8").includes(SPEC_MARK)) return file;
  const body = code?.trim() || (await codeFromDb(id));
  if (!body) throw new Error(`脚本源 ${id} 数据库里没有代码（code 为空），无法生成 ${file}`);
  saveScriptFile(id, body);
  log.info("script", `已按数据库代码生成 ${file}`);
  return file;
}

// 启动时补齐：所有 script 源缺文件就重新生成（删了 data/sources 重启即可恢复）
export async function materializeScripts(): Promise<{ total: number; generated: number[] }> {
  const { db, sources, eq } = await dbParts();
  const rows = await db.select({ id: sources.id, code: sources.code }).from(sources).where(eq(sources.type, "script"));
  const generated: number[] = [];
  for (const r of rows) {
    const file = `${SOURCES_DIR}/${r.id}.js`;
    if (existsSync(file) && readFileSync(file, "utf-8").includes(SPEC_MARK)) continue;
    try {
      await ensureScriptFile(r.id, r.code);
      generated.push(r.id);
    } catch (e: any) {
      log.warn("script", `生成 ${file} 失败：${e?.message ?? e}`);
    }
  }
  return { total: rows.length, generated };
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
  const scaffold = `import { fetchText, parse, abs, log, nodes, ruleText, ruleSel, browserOpen, browserText } from ${JSON.stringify(RUNTIME_SPEC)};\n\n`;
  try {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(withRuntime(scaffold + code)).toString("base64")}`);
    if (typeof mod.default !== "function") return "必须导出 export default class Source";
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

// 加载实例：按文件 mtime 缓存；模块经 data: URL 直载（Windows 下动态 import 新落盘文件有目录缓存竞态）
const cache = new Map<number, { mtime: number; inst: any }>();

export async function loadInst(id: number, fallbackCode?: string | null): Promise<any> {
  // 文件没了/是别台机器的格式 → 先用数据库代码补出文件（不重启也能自恢复）
  const file = await ensureScriptFile(id, fallbackCode);
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(id);
  if (hit && hit.mtime === mtime) return hit.inst;
  const raw = readFileSync(file, "utf-8");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(withRuntime(raw)).toString("base64")}`);
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

// 分页模板：next 里带 {page}/{ {page} } 占位符 = 按页码展开（与规则引擎一致）
const hasPageTpl = (s: string): boolean => /\{\{?page\}?\}/.test(s);
const expandPage = (t: string, n: number): string => t.replace(/\{\{?page\}?\}/g, String(n));

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

export async function scriptSearch(row: ScriptRow, key: string, log?: Log, timeoutMs = DEFAULT_TIMEOUT): Promise<BookItem[]> {
  const inst = await loadInst(row.id, row.code);
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
  row: ScriptRow,
  url: string,
  log?: Log,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<{ name: string; author: string; intro: string; cover: string; latestChapter: string; latestChapterUrl: string; tocUrl: string }> {
  const inst = await loadInst(row.id, row.code);
  if (typeof inst.getDetail !== "function") throw new Error("该源未实现 getDetail");
  log?.("info", "book", `脚本源详情: ${url}`);
  const info = await withTimeout(runWithInst(inst, () => inst.getDetail(url)), timeoutMs, "getDetail");
  const out = {
    name: String(info?.title ?? ""),
    author: String(info?.author ?? ""),
    intro: String(info?.desc ?? ""),
    cover: abs2(String(info?.cover ?? ""), inst.base),
    latestChapter: "",
    latestChapterUrl: "",
    tocUrl: abs2(String(info?.tocUrl || url), inst.base || url),
  };
  // 与规则源同样的「一行一条」：字段挤一行时看不出哪项 getDetail 没返回
  const miss = (v: string) => v || "⚠️未取到";
  log?.("ok", "book", `书名: ${miss(out.name)}`);
  log?.("ok", "book", `作者: ${miss(out.author)}`);
  log?.("ok", "book", `封面: ${miss(out.cover)}`);
  log?.("info", "book", `简介: ${out.intro ? out.intro.replace(/\s+/g, " ").slice(0, 60) + (out.intro.length > 60 ? "…" : "") : "⚠️未取到"}`);
  log?.("ok", "book", `目录地址: ${out.tocUrl}`);
  return out;
}

// 目录：源只返回当前页 {list, next}，翻页循环/防环/去重/上限都在引擎
export async function scriptToc(row: ScriptRow, tocUrl: string, log?: Log, timeoutMs = DEFAULT_TIMEOUT): Promise<ChapterItem[]> {
  const inst = await loadInst(row.id, row.code);
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

// 正文：源返回 string（单页）或 {text, next}（章节内翻页），引擎循环拼接后统一净化。
// next 里带 {page} 时视为分页模板（页内没有可跟的链接、但地址有规律），从第 2 页起按页码展开。
export async function scriptContent(row: ScriptRow, chapterUrl: string, log?: Log, timeoutMs = DEFAULT_TIMEOUT): Promise<string> {
  const inst = await loadInst(row.id, row.code);
  if (typeof inst.getContent !== "function") throw new Error("该源未实现 getContent");
  const parts: string[] = [];
  const visited = new Set<string>();
  let url: string | null = chapterUrl;
  let page = 0;
  let tpl: string | null = null; // 源返回的 {page} 模板
  let tplPage = 1;
  while (url && page < CONTENT_MAX_PAGES) {
    if (visited.has(url)) {
      log?.("warn", "content", `第 ${page + 1} 页地址已抓过，停止翻页`);
      break;
    }
    visited.add(url);
    page++;
    const cur: string = url;
    if (page > 1) log?.("info", "content", `正文第 ${page} 页: ${cur}`);
    // 第 2 页起失败（末页之后一串 404、模板盲试撞墙）：保留已抓到的部分，不该整章报废
    let r: any;
    try {
      r = await withTimeout(runWithInst(inst, () => inst.getContent(cur)), timeoutMs, "getContent");
    } catch (e: any) {
      if (page > 1) {
        log?.("warn", "content", `第 ${page} 页抓取失败（${e?.message ?? e}），返回已抓取的 ${page - 1} 页`);
        break;
      }
      throw e;
    }
    const text = typeof r === "string" ? r : String(r?.text ?? "");
    if (!text.trim()) {
      if (page > 1) {
        log?.("warn", "content", `第 ${page} 页正文为空，返回已抓取的 ${page - 1} 页`);
        break;
      }
      throw new Error("正文为空");
    }
    // 末页之后站点常原样返回最后一页：内容一模一样就收口，避免同一段拼满上限
    if (parts.length && text.trim() === parts[parts.length - 1].trim()) {
      log?.("warn", "content", `第 ${page} 页正文与上一页相同，判定已到最后一页`);
      break;
    }
    parts.push(text);
    const next = typeof r === "string" ? "" : String(r?.next ?? "").trim();
    if (tpl) {
      // 已在模板模式：不理会这一页返回的 next，按页码推进（页内链接在分页站上常常指向自己）
      tplPage++;
      url = abs2(expandPage(tpl, tplPage), inst.base);
      log?.("info", "content", `正文第 ${page + 1} 页（{page} 模板 · 第 ${tplPage} 页）: ${url}`);
    } else if (next && hasPageTpl(next)) {
      // 分页模板：首页即第 1 页，之后只按页码推进，不再看页内链接
      tpl = next;
      tplPage = 2;
      url = abs2(expandPage(tpl, tplPage), inst.base);
      log?.("info", "content", `识别到 {page} 模板分页，第 2 页: ${url}`);
    } else {
      url = next ? abs2(next, inst.base) : null;
      // 单页章节也要有日志，否则分不清「本来不分页」和「源没返回 next」
      if (!url) log?.("info", "content", page === 1 ? "正文无翻页：源未返回 next（按单页处理）" : `正文翻页结束：第 ${page} 页源未返回 next`);
    }
  }
  const merged = polish(parts.join("\n"), inst);
  const ph = isPlaceholder(merged);
  log?.("ok", "content", `脚本源正文 ${merged.length} 字${page > 1 ? ` · ${page} 页` : ""}${ph ? " · ⚠️疑似占位内容" : ""}`);
  return merged;
}
