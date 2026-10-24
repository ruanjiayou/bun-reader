import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

interface ContentResp {
  idx: number;
  title: string;
  content: string;
  isPlaceholder: boolean;
  cached: boolean;
}
type Theme = "dark" | "paper" | "black";
interface Prefs {
  fontSize: number;
  lineHeight: number;
  theme: Theme;
  rate?: number; // TTS 语速 0.5-2
  voiceURI?: string; // TTS 发音人
}

const THEMES: Record<Theme, { bg: string; text: string; sub: string }> = {
  dark: { bg: "bg-neutral-900", text: "text-neutral-200", sub: "text-neutral-500" },
  paper: { bg: "bg-[#f5efdc]", text: "text-[#3b3021]", sub: "text-[#8a7a5c]" },
  black: { bg: "bg-black", text: "text-neutral-400", sub: "text-neutral-600" },
};

const loadPrefs = (): Prefs => {
  try {
    return { fontSize: 18, lineHeight: 1.7, theme: "dark", ...JSON.parse(localStorage.getItem("reader-prefs") ?? "{}") };
  } catch {
    return { fontSize: 18, lineHeight: 1.7, theme: "dark" };
  }
};

// —— 线性图标（Feather 风格，currentColor 跟随文字色）——
const ICONS: Record<string, React.ReactNode> = {
  back: <polyline points="15 18 9 12 15 6" />,
  home: (
    <>
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </>
  ),
  shelf: (
    <>
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </>
  ),
  list: (
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </>
  ),
  book: (
    <>
      <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
      <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
    </>
  ),
  refresh: (
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </>
  ),
  speak: (
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 010 7.07" />
      <path d="M19.07 4.93a10 10 0 010 14.14" />
    </>
  ),
  settings: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
};
const Icon = ({ name, size = 22 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {ICONS[name]}
  </svg>
);

// 图标+文字（手机顶栏 / PC 左栏）
const NavItem = ({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) => (
  <button onClick={onClick} className="flex flex-col items-center gap-1 px-2 py-1.5 opacity-75 transition-opacity hover:opacity-100">
    <Icon name={icon} size={20} />
    <span className="text-[10px] leading-none">{label}</span>
  </button>
);
// 纯图标悬浮钮（title 提示；透明背景，跟随主题色）
const FloatBtn = ({ icon, title, onClick, active }: { icon: string; title: string; onClick: () => void; active?: boolean }) => (
  <button
    onClick={onClick}
    title={title}
    className={`flex h-10 w-10 items-center justify-center rounded-full transition-opacity hover:opacity-100 ${active ? "text-amber-500 opacity-100" : "opacity-75"}`}
  >
    <Icon name={icon} size={19} />
  </button>
);

// 阅读器：滚动模式；>500px 为 PC 布局（内容固定宽，左右紧贴工具栏），否则手机布局（顶栏+底栏+两侧悬浮钮）
export default function Reader() {
  const { id, idx: idxParam } = useParams();
  const bookId = Number(id);
  const idx = Number(idxParam);
  const nav = useNavigate();

  const [chapters, setChapters] = useState<{ idx: number; title: string; cached?: boolean }[]>([]);
  const [ch, setCh] = useState<ContentResp | null>(null);
  const [error, setError] = useState("");
  const [showToc, setShowToc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [speaking, setSpeaking] = useState(false);
  const [toast, setToast] = useState("");
  const [tick, setTick] = useState(0); // 错误重试触发器
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const preloaded = useRef<Map<number, ContentResp>>(new Map());
  const firstLoad = useRef(true); // 只有首次进入阅读器才恢复上次进度，章节间跳转一律回到开头
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  // TTS 发音人列表（浏览器异步加载）
  useEffect(() => {
    if (!window.speechSynthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  useEffect(() => localStorage.setItem("reader-prefs", JSON.stringify(prefs)), [prefs]);
  const theme = THEMES[prefs.theme];

  // 章节列表（目录弹层 / 上下章 / 百分比进度）
  useEffect(() => {
    api<{ chapters: { idx: number; title: string }[] }>(`/api/books/${bookId}/category`)
      .then((r) => setChapters(r.chapters))
      .catch(() => {});
  }, [bookId]);

  // 加载正文（优先用预加载缓存），并恢复上次滚动位置（scrollPos = 章内滚动百分比 0-100）
  useEffect(() => {
    let alive = true;
    setError("");
    setShowToc(false);
    setShowSettings(false);
    setCh(null);
    const cached = preloaded.current.get(idx);
    const apply = (r: ContentResp) => {
      if (!alive) return;
      setCh(r);
      if (firstLoad.current) {
        firstLoad.current = false;
        // 首次进入：恢复上次滚动位置（scrollPos = 章内滚动百分比 0-100）
        api<{ progress: { scrollPos: number } | null }>(`/api/books/${bookId}`)
          .then((b) => {
            if (!alive) return;
            const p = b.progress?.scrollPos ?? 0;
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = ((el.scrollHeight - el.clientHeight) * Math.min(p, 100)) / 100;
            });
          })
          .catch(() => {});
      } else {
        // 章节间跳转：直接回到开头
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        });
      }
      // 预加载下一章
      const nextIdx = idx + 1;
      if (chapters.some((c) => c.idx === nextIdx) && !preloaded.current.has(nextIdx)) {
        api<ContentResp>(`/api/books/${bookId}/content/${nextIdx}`)
          .then((r) => preloaded.current.set(nextIdx, r))
          .catch(() => {});
      }
    };
    if (cached) apply(cached);
    else
      api<ContentResp>(`/api/books/${bookId}/content/${idx}`)
        .then(apply)
        .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
      clearTimeout(saveTimer.current!);
      window.speechSynthesis?.cancel();
      setSpeaking(false);
    };
  }, [idx, bookId, tick]);

  // 滚动 → 防抖上报进度（scrollPos = 章内滚动百分比）
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    clearTimeout(saveTimer.current!);
    saveTimer.current = setTimeout(() => {
      const max = el.scrollHeight - el.clientHeight;
      const pct = max > 0 ? Math.round((el.scrollTop / max) * 1000) / 10 : 0;
      api(`/api/books/${bookId}/progress`, { method: "PUT", body: JSON.stringify({ chapterIdx: idx, scrollPos: pct }) }).catch(() => {});
    }, 800);
  };

  const goChapter = (to: number) => {
    if (to < 0 || (chapters.length && to >= chapters.length)) return setToast(chapters.length ? "没有更多章节" : "");
    nav(`/book/${bookId}/read/${to}`);
  };

  const refreshCh = async () => {
    try {
      const r = await api<ContentResp>(`/api/books/${bookId}/content/${idx}?refresh=1`);
      preloaded.current.delete(idx);
      setCh(r);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setToast(r.isPlaceholder ? "已刷新，但仍疑似占位内容" : "已刷新");
    } catch (e: any) {
      setToast(e.message);
    }
  };

  const cacheAll = async () => {
    try {
      const r = await api<any>(`/api/books/${bookId}/cache-all`, { method: "POST" });
      setToast(r.nothing ? "全部章节已缓存" : r.already ? "缓存任务进行中" : `开始后台缓存 ${r.queued} 章`);
    } catch (e: any) {
      setToast(e.message);
    }
  };

  // —— TTS：按段落链式朗读 ——
  const stopTts = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  };
  const toggleTts = () => {
    if (!window.speechSynthesis) return setToast("浏览器不支持语音合成");
    if (speaking) return stopTts();
    if (!ch) return;
    const paras = ch.content.split("\n").filter((p) => p.trim());
    let i = 0;
    const voice = voices.find((v) => v.voiceURI === prefs.voiceURI);
    const speakNext = () => {
      if (i >= paras.length) return setSpeaking(false);
      const u = new SpeechSynthesisUtterance(paras[i++]);
      u.lang = voice?.lang ?? "zh-CN";
      if (voice) u.voice = voice;
      u.rate = prefs.rate ?? 1;
      u.onend = speakNext;
      u.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    };
    setSpeaking(true);
    speakNext();
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const bookPct = chapters.length ? `${Math.round(((idx + 1) / chapters.length) * 1000) / 10}%` : "";

  return (
    <div className={`fixed inset-0 flex flex-col ${theme.bg} ${theme.text}`}>
      {/* 手机顶栏：返回 + 首页/书架/书源/目录 */}
      <div className="flex items-center gap-1 border-b border-neutral-700/50 px-1 py-1.5 min-[501px]:hidden" style={{ borderColor: "rgba(128,128,128,.25)" }}>
        <button onClick={() => nav(-1)} className="flex h-10 w-10 items-center justify-center opacity-75 hover:opacity-100" title="返回">
          <Icon name="back" />
        </button>
        <NavItem icon="home" label="首页" onClick={() => nav("/")} />
        <NavItem icon="shelf" label="书架" onClick={() => nav("/")} />
        <NavItem icon="globe" label="书源" onClick={() => nav("/sources")} />
        <NavItem icon="list" label="目录" onClick={() => setShowToc(true)} />
      </div>

      <div className="flex min-h-0 flex-1 justify-center">
        {/* PC 左栏：图标+文字，靠顶，紧贴内容左侧 */}
        <div className="hidden min-[501px]:flex min-[501px]:flex-col min-[501px]:items-start min-[501px]:gap-2 min-[501px]:py-4">
          <NavItem icon="home" label="首页" onClick={() => nav("/")} />
          <NavItem icon="shelf" label="书架" onClick={() => nav("/")} />
          <NavItem icon="globe" label="书源" onClick={() => nav("/sources")} />
          <NavItem icon="list" label="目录" onClick={() => setShowToc(true)} />
        </div>

        {/* 正文：滚动阅读（隐藏滚动条）；PC 固定 640px，两侧工具栏紧贴 */}
        <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar w-full min-w-0 flex-1 overflow-y-auto min-[501px]:w-[640px] min-[501px]:flex-none">
          <div className="mx-auto px-4 py-6 max-[500px]:px-5" style={{ fontSize: prefs.fontSize, lineHeight: prefs.lineHeight }}>
            {ch ? (
              <>
                <h2 className="mb-4 font-bold" style={{ fontSize: prefs.fontSize + 4 }}>
                  {ch.title}
                </h2>
                {ch.content.split("\n").map((p, i) =>
                  p.trim() ? (
                    <p key={i} className="mb-3 indent-8">
                      {p}
                    </p>
                  ) : null,
                )}
                <div className={`mt-8 text-center text-xs ${theme.sub}`}>— 本章完 · 下一章继续 —</div>
              </>
            ) : (
              <div className={`flex h-[60vh] items-center justify-center text-sm ${theme.sub}`}>
                {error ? (
                  <div className="text-center">
                    <p className="mb-3">{error}</p>
                    <button onClick={() => setTick((t) => t + 1)} className="rounded-lg bg-neutral-700 px-4 py-2 text-sm">
                      重试
                    </button>
                  </div>
                ) : (
                  "加载中…"
                )}
              </div>
            )}
          </div>
        </div>

        {/* PC 右栏：纯图标，靠底，紧贴内容 */}
        <div className="hidden min-[501px]:flex min-[501px]:flex-col min-[501px]:items-end min-[501px]:justify-end min-[501px]:gap-3 min-[501px]:py-4">
          <FloatBtn icon="book" title="书籍详情" onClick={() => nav(`/book/${bookId}`)} />
          <FloatBtn icon="refresh" title="刷新本章" onClick={refreshCh} />
          <FloatBtn icon="speak" title={speaking ? "停止朗读" : "朗读"} onClick={toggleTts} active={speaking} />
          <FloatBtn icon="settings" title="设置" onClick={() => setShowSettings(true)} />
        </div>

        {/* 手机左侧悬浮：书籍详情 / 缓存下载 */}
        <div className="fixed bottom-20 left-1 z-40 flex flex-col gap-3 min-[501px]:hidden">
          <FloatBtn icon="book" title="书籍详情" onClick={() => nav(`/book/${bookId}`)} />
          <FloatBtn icon="download" title="缓存下载" onClick={cacheAll} />
        </div>
        {/* 手机右侧悬浮：刷新 / 朗读 / 设置 */}
        <div className="fixed bottom-20 right-1 z-40 flex flex-col gap-3 min-[501px]:hidden">
          <FloatBtn icon="refresh" title="刷新本章" onClick={refreshCh} />
          <FloatBtn icon="speak" title={speaking ? "停止朗读" : "朗读"} onClick={toggleTts} active={speaking} />
          <FloatBtn icon="settings" title="设置" onClick={() => setShowSettings(true)} />
        </div>
      </div>

      {/* PC 底部：上一章 · 进度 · 下一章 */}
      <div className={`flex items-center justify-center gap-8 pb-3 text-xs min-[501px]:flex max-[500px]:hidden ${theme.sub}`}>
        <button onClick={() => goChapter(idx - 1)} className="px-3 py-1.5 opacity-75 transition-opacity hover:opacity-100">上一章</button>
        <span className="min-w-16 text-center">{chapters.length ? `${idx + 1}/${chapters.length} · ${bookPct}` : ""}</span>
        <button onClick={() => goChapter(idx + 1)} className="px-3 py-1.5 opacity-75 transition-opacity hover:opacity-100">下一章</button>
      </div>

      {/* 手机底栏：上一章 · 百分比进度 · 下一章 · 设置 */}
      <div className="flex items-center justify-around border-t px-2 py-2 min-[501px]:hidden" style={{ borderColor: "rgba(128,128,128,.25)" }}>
        <button onClick={() => goChapter(idx - 1)} className="px-4 py-1.5 text-sm opacity-80 hover:opacity-100">上一章</button>
        <span className="min-w-14 text-center text-xs opacity-60">{bookPct}</span>
        <button onClick={() => goChapter(idx + 1)} className="px-4 py-1.5 text-sm opacity-80 hover:opacity-100">下一章</button>
        <button onClick={() => setShowSettings(true)} className="px-4 py-1.5 text-sm opacity-80 hover:opacity-100">设置</button>
      </div>

      {/* 占位提示 toast */}
      {ch?.isPlaceholder && !showSettings && !showToc && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-30 -translate-x-1/2 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs text-white">
          本章疑似占位内容，可刷新重试
        </div>
      )}
      {toast && <div className="absolute left-1/2 top-14 z-50 -translate-x-1/2 rounded-lg bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100">{toast}</div>}

      {/* 目录弹层 */}
      {showToc && (
        <div className="absolute inset-0 z-40 overflow-y-auto bg-black/60" onClick={() => setShowToc(false)}>
          <div className={`mx-auto min-h-full min-[501px]:w-[640px] max-w-full p-4 ${theme.bg} ${theme.text}`} onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 mb-2 flex items-center bg-inherit pb-2 pt-1">
              <h3 className="text-sm font-bold">目录</h3>
              <span className="ml-2 text-xs opacity-50">共 {chapters.length} 章</span>
              <button onClick={() => setShowToc(false)} className="ml-auto px-2 text-lg opacity-60 hover:opacity-100">×</button>
            </div>
            <div className="divide-y" style={{ borderColor: "rgba(128,128,128,.2)" }}>
              {chapters.map((c) => (
                <button
                  key={c.idx}
                  onClick={() => {
                    setShowToc(false);
                    goChapter(c.idx);
                  }}
                  className={`block w-full truncate py-2.5 text-left text-sm hover:opacity-100 ${c.idx === idx ? "text-amber-400" : "opacity-80"}`}
                >
                  {c.title}
                  {c.cached && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" title="已缓存" />}
                  {c.idx === idx && <span className="ml-2 text-xs opacity-50">· 当前</span>}
                </button>
              ))}
              {!chapters.length && <div className="py-6 text-center text-sm opacity-50">目录加载中…</div>}
            </div>
          </div>
        </div>
      )}

      {/* 设置弹层：字号/行距/主题 */}
      {showSettings && (
        <div className="absolute inset-0 z-40 bg-black/50" onClick={() => setShowSettings(false)}>
          <div className={`absolute inset-x-0 bottom-0 rounded-t-2xl p-4 pb-8 ${theme.bg} ${theme.text}`} style={{ borderTop: "1px solid rgba(128,128,128,.35)" }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center">
              <h3 className="text-sm font-bold">设置</h3>
              <button onClick={() => setShowSettings(false)} className="ml-auto px-2 text-lg opacity-60 hover:opacity-100">×</button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3">
                <span className="w-14 opacity-60">字号</span>
                <button onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.max(14, p.fontSize - 2) }))} className="rounded bg-black/30 px-3">A-</button>
                <span>{prefs.fontSize}</span>
                <button onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.min(30, p.fontSize + 2) }))} className="rounded bg-black/30 px-3">A+</button>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 opacity-60">行距</span>
                <input type="range" min={1.4} max={2.4} step={0.1} value={prefs.lineHeight} onChange={(e) => setPrefs((p) => ({ ...p, lineHeight: Number(e.target.value) }))} className="flex-1 accent-amber-500" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 opacity-60">主题</span>
                {(["dark", "paper", "black"] as Theme[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setPrefs((p) => ({ ...p, theme: t }))}
                    className={`rounded-lg px-3 py-1 text-xs ${prefs.theme === t ? "ring-2 ring-amber-400" : ""} ${
                      t === "dark" ? "bg-neutral-900 text-neutral-200" : t === "paper" ? "bg-[#f5efdc] text-[#3b3021]" : "bg-black text-neutral-400"
                    }`}
                  >
                    {t === "dark" ? "暗色" : t === "paper" ? "羊皮纸" : "纯黑"}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 opacity-60">语速</span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={prefs.rate ?? 1}
                  onChange={(e) => setPrefs((p) => ({ ...p, rate: Number(e.target.value) }))}
                  className="flex-1 accent-amber-500"
                />
                <span className="w-10 text-right">{(prefs.rate ?? 1).toFixed(1)}x</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 flex-none opacity-60">发音人</span>
                <select
                  value={prefs.voiceURI ?? ""}
                  onChange={(e) => setPrefs((p) => ({ ...p, voiceURI: e.target.value }))}
                  className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1.5 text-xs"
                >
                  <option value="">系统默认</option>
                  {voices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {v.name}（{v.lang}）{v.localService ? "" : " · 在线"}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
