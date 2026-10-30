import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, API_BASE } from "../api";
import { useConfirm } from "../Confirm";

interface SourceRow {
  id: number;
  name: string;
  bookUrl: string;
  group: string;
  enabled: boolean;
  type: string; // rules = 规则表单源；script = class 脚本源
}
interface DebugEvt {
  level: "info" | "ok" | "warn" | "err";
  step: string;
  msg: string;
  info?: DebugBookInfo;
}
// SSE 上跑的不只有日志行：books（搜索书单）、tick（心跳秒数）、info（书籍信息）
interface StreamEvt {
  level?: DebugEvt["level"];
  step?: string;
  msg?: string;
  info?: DebugBookInfo;
  books?: SearchBook[];
  tick?: number;
}
interface DebugBookInfo {
  bookUrl: string;
  name: string;
  author: string;
  cover: string;
  intro: string;
  latestChapter: string;
}
interface SearchBook {
  name: string;
  author: string;
  bookUrl: string;
  cover: string;
  intro: string;
  latestChapter: string;
}

// 表单按区块声明，字段 = { path, label, ph 示例提示, rows 行数 }；规则一律 v2 链式调用语法
const SECTIONS: { title: string; fields: { path: string; label: string; ph?: string; rows?: number }[] }[] = [
  {
    title: "基本",
    fields: [
      { path: "bookSourceUrl", label: "源域名（必填，通常为网站主页）", ph: "https://www.example.com/" },
      { path: "bookSourceName", label: "源名称（必填）", ph: "示例源" },
      { path: "bookSourceGroup", label: "源分组", ph: "默认" },
      { path: "bookSourceComment", label: "源注释", ph: "作者 / 备注" },
      { path: "header", label: "请求头（JSON 字符串）", rows: 3, ph: '{"User-Agent":"Mozilla/5.0","Referer":"https://www.example.com/"}' },
      {
        path: "searchUrl",
        label: "搜索地址，支持 {{key}}/{{page}}，可带 ,{\"method\":\"POST\",\"body\":...}",
        rows: 2,
        ph: "/search/{{key}}.html\n或 /search.php,{\"method\":\"POST\",\"body\":\"kw={{key}}\"}",
      },
    ],
  },
  {
    title: "搜索",
    fields: [
      { path: "ruleSearch.bookList", label: "列表规则（选元素，不是取文本！）", rows: 2, ph: "'.bookbox'\n或 '.bookbox > div' / 'li.book'" },
      { path: "ruleSearch.name", label: "书名（文本）", ph: "'.bookname a'.text()" },
      { path: "ruleSearch.author", label: "作者（文本）", ph: "'.author'.text()##作者：|字数：.+" },
      { path: "ruleSearch.lastChapter", label: "最新章节（文本）", ph: "'.cat a'.text()" },
      { path: "ruleSearch.intro", label: "简介（文本）", ph: "'.update'.text()" },
      { path: "ruleSearch.coverUrl", label: "封面（图片，用 attr('src')）", ph: "'img'.attr('src') 或 '.thumbnail img'.attr('src')" },
      { path: "ruleSearch.bookUrl", label: "详情地址（链接 attr('href')，必填）", ph: "'.bookname a'.attr('href')" },
    ],
  },
  {
    title: "详情",
    fields: [
      { path: "ruleBookInfo.name", label: "书名（文本）", ph: "'h1'.text()" },
      { path: "ruleBookInfo.author", label: "作者（文本）", ph: "'.booktag a:eq(0)'.text()" },
      { path: "ruleBookInfo.lastChapter", label: "最新章节（文本）", ph: "'.bookchapter'.text()" },
      { path: "ruleBookInfo.intro", label: "简介（文本）", ph: "'.bookintro'.text()" },
      { path: "ruleBookInfo.coverUrl", label: "封面（图片，用 attr('src')）", ph: "'.thumbnail img'.attr('src')" },
      { path: "ruleBookInfo.tocUrl", label: "目录地址（链接 attr('href')，与详情页相同可留空）", ph: "'#allchapter a:eq(-1)'.attr('href')" },
    ],
  },
  {
    title: "目录",
    fields: [
      { path: "ruleToc.chapterList", label: "列表规则（选元素，不是取文本！）", rows: 2, ph: "'dd'\n或 '.chapter-list li' / '#all > dl dd'" },
      { path: "ruleToc.chapterName", label: "章节名称（相对列表项：.text() 取文本）", ph: "'a'.text()\n或 .text()（列表项本身是 a 时）\n或 .find('a').attr('title')（名称在属性里）" },
      { path: "ruleToc.chapterUrl", label: "章节地址（相对列表项取链接）", ph: "'a'.attr('href')\n或 .attr('href')（列表项本身是 a 时）" },
      { path: "ruleToc.nextTocUrl", label: "翻页规则（下一页链接，取到空即结束）", ph: "'.pagelink a:eq(-1)'.attr('href')\n或 '.next-page'.attr('href')" },
    ],
  },
  {
    title: "正文",
    fields: [
      { path: "ruleContent.content", label: "正文规则（段落换行用 .textBlocks()，多行直文本用 .textNodes()）", rows: 2, ph: "'#content'.textBlocks()（每个 p/div 一行）\n或 '.readcontent'.textBlocks()\n或 '.readcontent'.textNodes()（正文是裸文本节点时）" },
      {
        path: "ruleContent.nextContentUrl",
        label: "章节内翻页（正文分页的下一页链接；取到空即结束）",
        rows: 4,
        ph: "'.bottem a:eq(3)'.attr('href')（下一页）\n或 'a:contains(下一页)'.attr('href')\n或 text.下一页@href（按文字找，Legado 写法）\n分页地址有规律时用 {page} 模板：{{bookUrl}}##_?\\d*\\.html$##_{page}.html",
      },
      { path: "ruleContent.replaceRegex", label: "替换净化（正则##替换为，替换为留空=删除）", ph: "广告.*?<br>##\n（##广告.*?##  删除匹配内容）" },
    ],
  },
];

const emptyForm = () => ({
  bookSourceUrl: "",
  bookSourceName: "",
  bookSourceGroup: "默认",
  bookSourceComment: "",
  header: "",
  searchUrl: "",
  ruleSearch: {},
  ruleBookInfo: {},
  ruleToc: {},
  ruleContent: {},
  enabled: true,
});

const getIn = (obj: any, path: string) => path.split(".").reduce((o, k) => o?.[k], obj);
const setIn = (obj: any, path: string, v: any) => {
  const keys = path.split(".");
  const last = keys.pop()!;
  let cur = obj;
  for (const k of keys) cur = (cur[k] ??= {});
  cur[last] = v;
};

const levelColor: Record<DebugEvt["level"], string> = {
  info: "text-neutral-400",
  ok: "text-emerald-400",
  warn: "text-amber-400",
  err: "text-red-400",
};

// 脚本源按表单编辑：每个方法一个表单项，内容是基础模板（留空 = 未实现），保存时合并拼接为 class 文件
const METHOD_DEFS: { key: "search" | "getDetail" | "getChapters" | "getContent"; label: string; tpl: string }[] = [
  {
    key: "search",
    label: "搜索 search(name, page) → [{title, author, desc, cover, detailUrl}]",
    tpl: `async search(name, page = 1) {
  // 此处添加逻辑
  // const res = await fetchText(\`\${this.base}/search?kw=\${encodeURIComponent(name)}\`)
  // const $ = parse(res.text)
}`,
  },
  {
    key: "getDetail",
    label: "获取详情 getDetail(url) → { title, author, desc, cover, tocUrl }",
    tpl: `async getDetail(url) {
  // 此处添加逻辑
}`,
  },
  {
    key: "getChapters",
    label: "获取目录 getChapters(url) → { list: [{title, url}], next? }（翻页由引擎按 next 循环）",
    tpl: `async getChapters(url) {
  // 此处添加逻辑
}`,
  },
  {
    key: "getContent",
    label: "获取正文 getContent(url) → string 或 { text, next? }（翻页引擎拼接）",
    tpl: `async getContent(url) {
  // 此处添加逻辑
  // 正文分页：return { text, next } —— next 非空则引擎继续抓下一页并拼接
  // 分页地址有规律时 next 可写模板：return { text, next: url.replace(/\\.html$/, "_{page}.html") }
}`,
  },
];

const emptyScriptForm = () => ({
  name: "",
  base: "",
  headersText: "", // headers 成员（JSON 文本）
  replaceText: "", // replace 成员（每行 正则##替换为）
  enabled: true,
  methods: { search: "", getDetail: "", getChapters: "", getContent: "" } as Record<string, string>,
});

export default function Sources() {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [editId, setEditId] = useState<number | null>(null); // null = 新建未保存
  const [form, setForm] = useState<any>(emptyForm());
  const [jsonText, setJsonText] = useState("");
  const [rightTab, setRightTab] = useState<"json" | "debug" | "js">("json");
  const [msg, setMsg] = useState("");
  const [debugKey, setDebugKey] = useState("我的");
  const [dbgMode, setDbgMode] = useState<"search" | "book">("search");
  const [debugBookUrl, setDebugBookUrl] = useState("");
  const [searchResults, setSearchResults] = useState<SearchBook[]>([]);
  const [logs, setLogs] = useState<DebugEvt[]>([]);
  const [debugging, setDebugging] = useState(false);
  const [tickSec, setTickSec] = useState(0); // SSE 心跳：仍在运行多少秒（长时间静默时给反馈）
  const [dirty, setDirty] = useState(false); // 表单/JSON 有未保存改动 → 保存按钮高亮
  const [dbgBook, setDbgBook] = useState<DebugBookInfo | null>(null); // 调试全链路成功后的书籍信息，可加书架
  const [addingBook, setAddingBook] = useState(false);
  const [srcType, setSrcType] = useState<"rules" | "script">("rules"); // 当前编辑上下文的源类型
  const [scriptForm, setScriptForm] = useState(emptyScriptForm()); // 脚本源表单（保存时合并生成 class 脚本）
  const [scriptCode, setScriptCode] = useState(""); // 右侧「生成的 JS」只读预览（rules/script 都是生成产物）
  const nav = useNavigate();
  const { id: routeId } = useParams(); // /sources/new = 新建；/sources/:id = 编辑/调试
  const logBox = useRef<HTMLDivElement>(null);
  const [ask, confirmUi] = useConfirm();

  const load = () => api<SourceRow[]>("/api/sources").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs]);
  // 提示信息 4 秒自动消失
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  // —— 编辑 ——
  const setField = (path: string, v: string) => {
    setDirty(true);
    setForm((f: any) => {
      const next = structuredClone(f);
      setIn(next, path, v);
      return next;
    });
  };
  // 表单 → JSON 文本（去掉空规则对象）
  const formJson = (f: any) => {
    const clean = structuredClone(f);
    for (const k of ["ruleSearch", "ruleBookInfo", "ruleToc", "ruleContent"])
      if (!Object.keys(clean[k] ?? {}).length) delete clean[k];
    return JSON.stringify(clean, null, 2);
  };
  const selectSource = async (id: number | null | "new-script") => {
    setLogs([]);
    setDirty(false);
    setDbgBook(null);
    if (id === null) {
      setEditId(null);
      setForm(emptyForm());
      setJsonText("");
      setSrcType("rules");
      setScriptForm(emptyScriptForm());
      setScriptCode("");
      setMsg("");
      return;
    }
    if (id === "new-script") {
      setEditId(null);
      setForm(emptyForm());
      setJsonText("");
      setSrcType("script");
      setScriptForm(emptyScriptForm());
      setScriptCode("");
      setRightTab("debug");
      setMsg("新建脚本源：填好方法后点「保存源」，保存时自动合并生成 class 脚本");
      return;
    }
    try {
      const row = await api<{ id: number; name?: string; json: string; type: string; enabled: boolean }>(`/api/sources/${id}`);
      setEditId(id);
      setSrcType(row.type === "script" ? "script" : "rules");
      if (row.type === "script") {
        // script 源的 json 存的是表单数据（保存时的真相），code 是生成产物（只读）
        const f = JSON.parse(row.json || "{}");
        // headers 兼容字符串形态（规则源 header 带过来的旧数据）：先解析成对象再展示，避免 textarea 里出现二次编码
        let h = f.headers;
        if (typeof h === "string") {
          try {
            h = JSON.parse(h);
          } catch {
            h = null;
          }
        }
        setScriptForm({
          name: f.name ?? row.name ?? "",
          base: f.base ?? "",
          headersText: h && Object.keys(h).length ? JSON.stringify(h, null, 2) : "",
          replaceText: (f.replace ?? []).map((r: any) => `${r.regex}##${r.replacement ?? ""}`).join("\n"),
          enabled: row.enabled !== false,
          methods: {
            search: f.methods?.search ?? "",
            getDetail: f.methods?.getDetail ?? "",
            getChapters: f.methods?.getChapters ?? "",
            getContent: f.methods?.getContent ?? "",
          },
        });
        setForm(emptyForm());
        setJsonText("");
        setRightTab((t) => (t === "json" ? "debug" : t));
        const { code } = await api<{ code: string }>(`/api/sources/${id}/code`);
        setScriptCode(code);
      } else {
        // header 数据库统一存对象，textarea 里以 JSON 文本展示
        const parsed = JSON.parse(row.json);
        if (parsed.header && typeof parsed.header === "object") parsed.header = JSON.stringify(parsed.header, null, 2);
        setForm(parsed);
        setJsonText(JSON.stringify(parsed, null, 2));
        setScriptCode("");
      }
      setMsg("");
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  // 返回书源列表：有未保存改动先问一句，避免手滑丢掉正在编辑的规则
  const backToList = async () => {
    if (dirty) {
      const ok = await ask({
        title: "放弃未保存的改动？",
        desc: "当前表单/JSON 的修改还没保存，返回列表会丢失。",
        okText: "放弃",
      });
      if (!ok) return;
    }
    nav("/sources");
  };

  // 清空成新建：先把表单复位，URL 也跟到 /sources/new（否则停在 /sources/12 上却是个空表单）
  const startNewBlank = () => {
    selectSource(null);
    if (routeId !== "new") nav("/sources/new", { replace: true });
  };

  // 路由 → 编辑上下文：/sources/new 新建，/sources/:id 载入该源；?tab=debug 直接从调试页进来
  useEffect(() => {
    const debugTab = new URLSearchParams(window.location.search).get("tab") === "debug";
    const rid = !routeId || routeId === "new" ? null : Number(routeId);
    if (rid === null || Number.isNaN(rid)) selectSource(null);
    else selectSource(rid);
    if (debugTab) setRightTab("debug");
  }, [routeId]);

  // 新建保存后把 URL 换成 /sources/:id：replaceState 不进历史（返回仍回书源列表），刷新后能直达这条源。
  // 只替换路径尾段而非用绝对路径，保留部署前缀（如 /reader/sources/12）
  const syncUrl = (id: number) => {
    const path = window.location.pathname.replace(/\/sources(\/[^/]+)?$/, `/sources/${id}`);
    window.history.replaceState(window.history.state, "", `${path}${window.location.search}`);
  };

  // JSON → 表单（失焦时静默同步），非法 JSON 不覆盖表单并给出提示，避免后续表单失焦把 JSON 改动悄悄冲掉
  const syncJsonToForm = (): boolean => {
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed.header && typeof parsed.header === "object") parsed.header = JSON.stringify(parsed.header, null, 2);
      setForm({ ...emptyForm(), ...parsed });
      return true;
    } catch {
      if (jsonText.trim()) setMsg("JSON 格式有误，未同步到左侧表单（修正后再失焦即可）");
      return false;
    }
  };
  // 保存当前源（upsert），返回源 id。rules 走 import 接口；script 走专用接口（新建/更新代码）
  const saveSource = async (): Promise<number | null> => {
    try {
      if (srcType === "script") {
        if (!scriptForm.name.trim()) {
          setMsg("缺少源名称");
          return null;
        }
        let headers: Record<string, string> = {};
        if (scriptForm.headersText.trim()) {
          try {
            headers = JSON.parse(scriptForm.headersText);
            if (typeof headers !== "object" || headers === null || Array.isArray(headers)) throw new Error("not object");
          } catch {
            setMsg("请求头 headers 不是合法的 JSON 对象");
            return null;
          }
        }
        const replace = scriptForm.replaceText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf("##");
            return i === -1 ? { regex: l, replacement: "" } : { regex: l.slice(0, i), replacement: l.slice(i + 2) };
          });
        const methods: Record<string, string> = {};
        for (const k of ["search", "getDetail", "getChapters", "getContent"]) if (scriptForm.methods[k]?.trim()) methods[k] = scriptForm.methods[k];
        const body = { name: scriptForm.name.trim(), base: scriptForm.base.trim(), headers, replace, methods };
        if (editId === null) {
          const r = await api<{ id: number }>("/api/sources/script", { method: "POST", body: JSON.stringify(body) });
          setEditId(r.id);
          syncUrl(r.id);
          await load();
          const { code } = await api<{ code: string }>(`/api/sources/${r.id}/code`);
          setScriptCode(code);
          setMsg("脚本源已创建（已合并生成 class 脚本）");
          setDirty(false);
          return r.id;
        }
        await api(`/api/sources/script/${editId}`, { method: "PUT", body: JSON.stringify(body) });
        await load();
        const { code } = await api<{ code: string }>(`/api/sources/${editId}/code`);
        setScriptCode(code);
        setMsg("已保存，class 脚本已重新生成");
        setDirty(false);
        return editId;
      }
      const text = jsonText.trim().startsWith("{") ? jsonText : JSON.stringify(form);
      await api("/api/sources/import", { method: "POST", body: JSON.stringify({ text }) });
      await load();
      const url = JSON.parse(text).bookSourceUrl;
      const row = rows.find((r) => r.bookUrl === url) ?? (await api<SourceRow[]>("/api/sources")).find((r) => r.bookUrl === url);
      if (row) {
        setEditId(row.id);
        syncUrl(row.id); // 新建 → URL 变 /sources/:id（已有源则原样）
      }
      setMsg("已保存");
      setDirty(false);
      return row?.id ?? null;
    } catch (e: any) {
      setMsg(e.message);
      return null;
    }
  };
  const del = async () => {
    if (editId === null) return setMsg("当前是未保存的新源");
    const name = srcType === "script" ? scriptForm.name : form.bookSourceName;
    const ok = await ask({
      title: `删除书源「${name}」？`,
      desc: srcType === "script" ? "生成的脚本文件会一并删除，无法撤销。" : "规则配置会被删除，无法撤销。",
      okText: "删除",
    });
    if (!ok) return;
    await api(`/api/sources/${editId}`, { method: "DELETE" });
    nav("/sources", { replace: true }); // 回到书源列表
  };
  const toggleEnabled = async () => {
    if (editId === null) return setMsg("先保存后再启停");
    const cur = srcType === "script" ? scriptForm.enabled : !!form.enabled;
    await api(`/api/sources/${editId}`, { method: "PUT", body: JSON.stringify({ enabled: !cur }) });
    if (srcType === "script") setScriptForm((f) => ({ ...f, enabled: !f.enabled }));
    else setForm((f: any) => ({ ...f, enabled: !f.enabled }));
    load();
  };
  // —— 调试：调已保存的源（不自动保存）——
  // 统一走 SSE：调试链路可能几十秒（浏览器启动 + 人机验证），日志必须边跑边到，不能攒到最后一次性返回
  const streamDebug = async (body: Record<string, unknown>, onEvt: (e: StreamEvt) => void) => {
    const res = await fetch(`${API_BASE}/api/sources/${editId}/debug`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      throw new Error(`调试接口 ${res.status}${txt ? ` · ${txt.slice(0, 120)}` : ""}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop()!;
      for (const p of parts) {
        const line = p.trim();
        if (!line.startsWith("data: ")) continue;
        try {
          onEvt(JSON.parse(line.slice(6)) as StreamEvt);
        } catch {
          /* 半截 JSON（chunk 边界）忽略，下轮补全 */
        }
      }
    }
  };

  const runDebugSearch = async () => {
    if (editId === null) return setMsg("先保存源再调试");
    setDebugging(true);
    setSearchResults([]);
    setLogs([]);
    setDbgBook(null);
    setTickSec(0);
    let got: SearchBook[] = [];
    let err = "";
    try {
      await streamDebug({ mode: "search", key: debugKey }, (evt) => {
        if (evt.tick) return setTickSec(evt.tick);
        if (evt.books) {
          got = evt.books;
          return setSearchResults(evt.books);
        }
        const line = { level: evt.level ?? "info", step: evt.step ?? "?", msg: evt.msg ?? "" };
        setLogs((l) => [...l, line]);
        if (line.level === "err" && line.step === "done") err = line.msg;
      });
      setMsg(got.length ? `搜索到 ${got.length} 条` : err || "搜索无结果");
    } catch (e: any) {
      setLogs((l) => [...l, { level: "err", step: "client", msg: e.message }]);
      setMsg(e.message);
    } finally {
      setDebugging(false);
    }
  };
  const runDebugBook = async () => {
    if (editId === null) return setMsg("先保存源再调试");
    if (!debugBookUrl.trim()) return setMsg("输入书籍详情页 URL");
    setLogs([]);
    setDbgBook(null);
    setTickSec(0);
    setDebugging(true);
    try {
      await streamDebug({ bookUrl: debugBookUrl.trim() }, (evt) => {
        if (evt.tick) return setTickSec(evt.tick);
        if (evt.step === "bookinfo" && evt.info) return setDbgBook(evt.info);
        setLogs((l) => [...l, { level: evt.level ?? "info", step: evt.step ?? "?", msg: evt.msg ?? "" }]);
      });
    } catch (e: any) {
      setLogs((l) => [...l, { level: "err", step: "client", msg: e.message }]);
    } finally {
      setDebugging(false);
    }
  };

  // 调试全链路成功后一键加书架（无搜索的源靠这个入库）：books 表立即落库，目录后台异步补
  const addBookFromDebug = async () => {
    if (!dbgBook || editId === null) return;
    setAddingBook(true);
    try {
      const r = await api<{ id: number }>("/api/books", {
        method: "POST",
        body: JSON.stringify({
          bookUrl: dbgBook.bookUrl,
          sourceId: editId,
          info: { name: dbgBook.name, author: dbgBook.author, cover: dbgBook.cover, intro: dbgBook.intro, latestChapter: dbgBook.latestChapter },
        }),
      });
      setMsg(`已加入书架：《${dbgBook.name}》`);
      nav(`/book/${r.id}`);
    } catch (e: any) {
      setMsg(`加书架失败：${e.message}`);
      setAddingBook(false);
    }
  };

  const cur = rows.find((r) => r.id === editId);
  const btn = "w-full rounded-lg bg-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-500";
  const btnPrimary = "w-full rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-amber-400";
  const inpMono = "w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs placeholder:text-neutral-500";

  return (
    <div className="mx-auto min-h-dvh max-w-7xl p-4">
      {confirmUi}
      {/* 顶栏：左返回书源列表，标题=当前源名/新建；新建时可选类型 */}
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={backToList}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
          title="返回书源列表"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className="max-w-[14rem] truncate text-lg font-bold">
          {editId === null ? (srcType === "script" ? "新建脚本源" : "新建书源") : (srcType === "script" ? scriptForm.name : form.bookSourceName) || `书源 #${editId}`}
        </h1>
        {editId !== null && <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">#{editId}</span>}
        {editId === null && (
          <div className="flex gap-1">
            {(["rules", "script"] as const).map((t) => (
              <button
                key={t}
                onClick={() => selectSource(t === "script" ? "new-script" : null)}
                className={`rounded-lg px-2.5 py-1 text-xs ${srcType === t ? "bg-neutral-600 text-neutral-100" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"}`}
              >
                {t === "rules" ? "规则源" : "脚本源"}
              </button>
            ))}
          </div>
        )}
      </header>
      {msg && (
        <div className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 shadow-lg">
          {msg}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,5fr)_9rem_minmax(0,6fr)]">
        {/* 左：编辑表单（吸附，独立滚动） */}
        <div className="space-y-3 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto md:pr-1">
          {srcType === "script" ? (
            <>
              <div className="rounded-xl bg-neutral-800 p-3 text-xs leading-5 text-neutral-400">
                脚本源按表单编辑：每个方法留空即未实现；保存时把各方法合并拼接成 class 脚本文件供程序执行（右侧「生成的 JS」只读预览）。
              </div>
              <fieldset className="rounded-xl bg-neutral-800 p-4">
                <legend className="px-1 text-sm font-bold text-amber-400">基本</legend>
                <div className="space-y-2">
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">源名称（必填）</span>
                    <input
                      className={inpMono}
                      placeholder="示例脚本源"
                      value={scriptForm.name}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, name: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">源域名 base（相对地址补全，等价类成员 base）</span>
                    <input
                      className={inpMono}
                      placeholder="https://www.example.com"
                      value={scriptForm.base}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, base: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">请求头 headers（JSON 对象，注入每次 fetchText）</span>
                    <textarea
                      rows={3}
                      className={inpMono}
                      placeholder={'{"Cookie":"...","Referer":"https://www.example.com/"}'}
                      value={scriptForm.headersText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, headersText: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">替换净化 replace（每行：正则##替换为，替换为留空=删除）</span>
                    <textarea
                      rows={2}
                      className={inpMono}
                      placeholder={"广告.*?##\n（本章完）##"}
                      value={scriptForm.replaceText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, replaceText: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                </div>
              </fieldset>
              <fieldset className="rounded-xl bg-neutral-800 p-4">
                <legend className="px-1 text-sm font-bold text-amber-400">方法（全可选，○ 未实现 ● 已填写）</legend>
                <div className="space-y-2">
                  {METHOD_DEFS.map((m) => (
                    <details key={m.key} className="rounded-lg bg-neutral-900">
                      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-neutral-300">
                        {scriptForm.methods[m.key]?.trim() ? "●" : "○"} {m.label}
                      </summary>
                      <textarea
                        rows={10}
                        spellCheck={false}
                        className="w-full border-t border-neutral-700 bg-neutral-900 p-3 font-mono text-xs leading-5 text-neutral-200 placeholder:text-neutral-600"
                        placeholder={m.tpl}
                        value={scriptForm.methods[m.key] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setScriptForm((f) => ({ ...f, methods: { ...f.methods, [m.key]: v } }));
                          setDirty(true);
                        }}
                      />
                    </details>
                  ))}
                  <div className="pt-1 text-xs leading-5 text-neutral-500">
                    可用 API：fetchText(url, opts?) → {"{status, text, url}"}；parse(html) → cheerio $；abs(u, base?) 相对转绝对；log(msg)；
                    nodes(html) / ruleText(ns, 规则) / ruleSel(ns, 规则)（规则语法兼容，正文换行推荐 .textBlocks()）。this.base / this.headers / this.replace 为类成员。
                  </div>
                </div>
              </fieldset>
            </>
          ) : (
            SECTIONS.map((sec) => (
            <fieldset key={sec.title} className="rounded-xl bg-neutral-800 p-4">
              <legend className="px-1 text-sm font-bold text-amber-400">{sec.title}</legend>
              <div className="space-y-2">
                {sec.fields.map(({ path, label, ph, rows: rowsN = 1 }) => (
                  <label key={path} className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">{label}</span>
                    {rowsN > 1 ? (
                      <textarea
                        rows={rowsN}
                        className="w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs placeholder:text-neutral-500"
                        placeholder={ph}
                        value={getIn(form, path) ?? ""}
                        onChange={(e) => setField(path, e.target.value)}
                        onBlur={() => setJsonText(formJson(form))}
                      />
                    ) : (
                      <input
                        className="w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs placeholder:text-neutral-500"
                        placeholder={ph}
                        value={getIn(form, path) ?? ""}
                        onChange={(e) => setField(path, e.target.value)}
                        onBlur={() => setJsonText(formJson(form))}
                      />
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
            ))
          )}
        </div>

        {/* 中：操作列 */}
        <div className="flex flex-row flex-wrap gap-2 md:sticky md:top-4 md:flex-col">
          <button
            onClick={saveSource}
            className={dirty ? `${btnPrimary} ring-2 ring-amber-300/60` : btn}
            title={dirty ? "有未保存的改动" : "无改动"}
          >
            {dirty ? "● 保存源" : "保存源"}
          </button>
          <button onClick={startNewBlank} className={btn}>✗ 清空新建</button>
          <label className="flex items-center gap-2 px-1 text-sm text-neutral-400">
            <input
              type="checkbox"
              checked={srcType === "script" ? scriptForm.enabled : !!form.enabled}
              onChange={toggleEnabled}
              className="accent-amber-500"
              disabled={editId === null}
            />
            启用搜索
          </label>
          {editId !== null && (
            <button onClick={del} className="w-full rounded-lg px-3 py-1.5 text-sm text-red-400 hover:bg-red-950">删除此源</button>
          )}        </div>

        {/* 右：JSON / 调试 */}
        <div className="flex flex-col rounded-xl bg-neutral-800 p-3 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)]">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {(["json", "js", "debug"] as const).map((t) =>
              (t === "js" && editId === null) || (t === "json" && srcType === "script") ? null : (
                <button
                  key={t}
                  onClick={() => {
                    setRightTab(t);
                    if (t === "js" && editId !== null)
                      api<{ code: string; generated: boolean }>(`/api/sources/${editId}/code`)
                        .then((r) => setScriptCode(r.code))
                        .catch((e) => setMsg(e.message));
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm ${rightTab === t ? "bg-amber-500 font-medium text-neutral-900" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                >
                  {t === "json" ? "JSON" : t === "js" ? "生成的 JS" : "调试"}
                </button>
              ),
            )}
          </div>
          {rightTab === "json" ? (
            <textarea
              className="h-96 w-full flex-1 rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5 md:h-auto"
              placeholder="表单→JSON 生成；或粘贴 JSON 后失焦自动同步到表单"
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setDirty(true);
              }}
              onBlur={() => syncJsonToForm()}
            />
          ) : rightTab === "js" ? (
            <pre className="h-96 w-full flex-1 overflow-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5 whitespace-pre text-neutral-300 md:h-auto">
              {scriptCode}
            </pre>
          ) : (
            <div className="flex flex-1 flex-col gap-2 overflow-hidden">
              {/* 子模式切换 + 输入 */}
              <div className="flex flex-wrap items-center gap-1">
                {(["search", "book"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setDbgMode(m)}
                    className={`rounded-lg px-3 py-1 text-xs ${dbgMode === m ? "bg-neutral-600 font-medium text-neutral-100" : "bg-neutral-700 text-neutral-400 hover:bg-neutral-600"}`}
                  >
                    {m === "search" ? "调搜索" : "调书籍"}
                  </button>
                ))}
                {dbgMode === "search" ? (
                  <>
                    <input
                      className="ml-auto w-36 rounded-lg bg-neutral-700 px-2 py-1 text-xs"
                      placeholder="搜索关键词"
                      value={debugKey}
                      onChange={(e) => setDebugKey(e.target.value)}
                    />
                    <button onClick={runDebugSearch} disabled={debugging} className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50">
                      运行
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      className="ml-auto w-56 flex-1 rounded-lg bg-neutral-700 px-2 py-1 font-mono text-xs"
                      placeholder="书籍详情页 URL"
                      value={debugBookUrl}
                      onChange={(e) => setDebugBookUrl(e.target.value)}
                    />
                    <button onClick={runDebugBook} disabled={debugging} className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50">
                      运行
                    </button>
                  </>
                )}
              </div>
              {/* 调搜索：结果列表 */}
              {dbgMode === "search" && searchResults.length > 0 && (
                <div className="max-h-[45%] shrink-0 overflow-y-auto rounded-lg bg-neutral-900 p-2">
                  {searchResults.map((b, i) => (
                    <div key={i} className="mb-2 rounded-lg bg-neutral-800 p-2 text-xs">
                      <div className="flex items-center gap-2">
                        {b.cover && <img src={b.cover} alt="" className="h-12 w-9 flex-none rounded object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />}
                        <div className="min-w-0">
                          <div className="truncate font-medium text-neutral-100">{b.name}</div>
                          <div className="truncate text-neutral-400">
                            {b.author || "佚名"}
                            {b.latestChapter && ` · ${b.latestChapter}`}
                          </div>
                        </div>
                      </div>
                      {b.intro && <div className="mt-1 line-clamp-2 text-neutral-500">{b.intro}</div>}
                      <button
                        onClick={() => {
                          setDebugBookUrl(b.bookUrl);
                          setDbgMode("book");
                          setRightTab("debug");
                          setLogs([]);
                          setDbgBook(null);
                          setMsg(`已填入调书籍：${b.name}`);
                        }}
                        className="mt-1 max-w-full truncate rounded bg-neutral-700 px-1.5 py-0.5 text-left font-mono text-[11px] text-sky-400 hover:bg-neutral-600 hover:text-sky-300"
                        title="点击填入「调书籍」继续测试"
                      >
                        {b.bookUrl}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* 调书籍：详情解析结果（封面/作者/最新章），详情一解析完就出现，不用等目录正文 */}
              {dbgMode === "book" && dbgBook && (
                <div className="flex shrink-0 gap-2 rounded-lg bg-neutral-900 p-2">
                  {dbgBook.cover ? (
                    <img
                      src={dbgBook.cover}
                      alt=""
                      className="h-[84px] w-[60px] flex-none rounded bg-neutral-800 object-cover"
                      onError={(e) => {
                        e.currentTarget.style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <div className="flex h-[84px] w-[60px] flex-none items-center justify-center rounded bg-neutral-800 text-[10px] text-neutral-600">无封面</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-100">{dbgBook.name || "（未取到书名）"}</div>
                    <div className="truncate text-xs">
                      <span className="text-neutral-500">作者 </span>
                      {dbgBook.author ? <span className="text-neutral-300">{dbgBook.author}</span> : <span className="text-amber-400">未取到（规则 ruleBookInfo.author / 脚本 getDetail 的 author）</span>}
                    </div>
                    <div className="truncate text-xs">
                      <span className="text-neutral-500">最新 </span>
                      <span className={dbgBook.latestChapter ? "text-neutral-300" : "text-neutral-600"}>{dbgBook.latestChapter || "未取到"}</span>
                    </div>
                    {dbgBook.intro && <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-neutral-500">{dbgBook.intro}</div>}
                    <div className="truncate font-mono text-[10px] text-neutral-600" title={dbgBook.bookUrl}>
                      {dbgBook.bookUrl}
                    </div>
                  </div>
                </div>
              )}
              {/* 日志：两种模式共用，SSE 逐步追加 */}
              <div ref={logBox} className="min-h-24 flex-1 overflow-y-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5">
                {logs.map((l, i) => (
                  <div key={i} className={levelColor[l.level]}>
                    <span className="text-neutral-600">[{l.step}]</span> {l.msg}
                  </div>
                ))}
                {debugging && (
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                    运行中{tickSec ? ` · ${tickSec}s` : ""}
                    <span className="text-neutral-600">（长耗时步骤：浏览器启动 / 人机验证 / 目录与正文翻页）</span>
                  </div>
                )}
                {!logs.length && !debugging && (
                  <div className="text-neutral-600">
                    {dbgMode === "book" ? "粘贴书籍详情页 URL 点运行：详情 → 目录 → 首章正文" : "输入关键词点运行：先看搜索书单，再点书籍 URL 深入测详情/目录/正文"}
                  </div>
                )}
              </div>
              {dbgMode === "book" && dbgBook && !debugging && (
                <button
                  onClick={addBookFromDebug}
                  disabled={addingBook}
                  className="w-full shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-amber-400 disabled:opacity-50"
                >
                  {addingBook ? "加入中…" : `＋ 加入书架《${dbgBook.name || dbgBook.bookUrl}》`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
