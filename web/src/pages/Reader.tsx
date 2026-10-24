import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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

export default function Reader() {
  const { id, idx: idxParam } = useParams();
  const bookId = Number(id);
  const idx = Number(idxParam);
  const nav = useNavigate();

  const [chapters, setChapters] = useState<{ idx: number; title: string }[]>([]);
  const [ch, setCh] = useState<ContentResp | null>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [toast, setToast] = useState("");
  const [tick, setTick] = useState(0); // 错误重试触发器
  const bodyRef = useRef<HTMLDivElement>(null);
  const preloaded = useRef<Map<number, ContentResp>>(new Map());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => localStorage.setItem("reader-prefs", JSON.stringify(prefs)), [prefs]);
  const theme = THEMES[prefs.theme];

  // 章节列表（用于滑杆与上下章）
  useEffect(() => {
    api<{ chapters: { idx: number; title: string }[] }>(`/api/books/${bookId}/category`)
      .then((r) => setChapters(r.chapters))
      .catch(() => {});
  }, [bookId]);

  // 加载正文（优先用预加载缓存）
  useEffect(() => {
    let alive = true;
    setError("");
    setMenu(false);
    setCh(null);
    setPage(0);
    const cached = preloaded.current.get(idx);
    const apply = (r: ContentResp) => {
      if (!alive) return;
      setCh(r);
      // 恢复章内页码（进度 scrollPos 存的是页码）
      api<{ progress: { scrollPos: number } | null }>(`/api/books/${bookId}`)
        .then((b) => {
          if (alive && b.progress?.scrollPos && b.progress.scrollPos > 0) {
            // 页数要在渲染后才知道，先存着，渲染 effect 里 clamp
            pendingPage.current = b.progress.scrollPos;
          }
        })
        .catch(() => {});
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
      window.speechSynthesis?.cancel();
      setSpeaking(false);
    };
  }, [idx, bookId, tick]);
  const pendingPage = useRef(0);

  // 分页计算：CSS 多栏，pages = scrollWidth / 栏宽
  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const w = el.parentElement!.clientWidth;
    const total = Math.max(1, Math.round((el.scrollWidth + 4) / (w + 2)));
    setPages(total);
    if (pendingPage.current > 0) {
      setPage(Math.min(pendingPage.current, total - 1));
      pendingPage.current = 0;
    } else setPage((p) => Math.min(p, total - 1));
  }, []);
  useEffect(() => {
    if (!ch) return;
    const t = setTimeout(measure, 50);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [ch, prefs, measure]);

  // 进度上报（防抖）：scrollPos = 章内页码
  useEffect(() => {
    if (!ch) return;
    clearTimeout(saveTimer.current!);
    saveTimer.current = setTimeout(() => {
      api(`/api/books/${bookId}/progress`, { method: "PUT", body: JSON.stringify({ chapterIdx: idx, scrollPos: page }) }).catch(() => {});
    }, 800);
    return () => clearTimeout(saveTimer.current!);
  }, [idx, page, ch, bookId]);

  const goChapter = (to: number) => {
    if (to < 0 || (chapters.length && to >= chapters.length)) return setToast(chapters.length ? "没有更多章节" : "");
    nav(`/book/${bookId}/read/${to}`);
  };
  const turn = (dir: 1 | -1) => {
    const next = page + dir;
    if (next < 0) goChapter(idx - 1);
    else if (next >= pages) goChapter(idx + 1);
    else setPage(next);
  };

  const refreshCh = async () => {
    try {
      const r = await api<ContentResp>(`/api/books/${bookId}/content/${idx}?refresh=1`);
      preloaded.current.delete(idx);
      setCh(r);
      setPage(0);
      measure();
      setToast(r.isPlaceholder ? "已刷新，但仍疑似占位内容" : "已刷新");
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
    const speakNext = () => {
      if (i >= paras.length) return setSpeaking(false);
      const u = new SpeechSynthesisUtterance(paras[i++]);
      u.lang = "zh-CN";
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

  const click = (e: React.MouseEvent) => {
    if (menu) return setMenu(false);
    const x = e.clientX / window.innerWidth;
    if (x < 0.33) turn(-1);
    else if (x > 0.67) turn(1);
    else setMenu(true);
  };

  const w = bodyRef.current?.parentElement?.clientWidth ?? window.innerWidth;

  return (
    <div className={`fixed inset-0 flex flex-col ${theme.bg} ${theme.text}`} onClick={click}>
      {/* 正文分栏 */}
      <div className="flex-1 overflow-hidden">
        {ch ? (
          <div
            ref={bodyRef}
            className="h-full"
            style={{
              columnWidth: w,
              columnGap: 48,
              height: "100%",
              width: w,
              fontSize: prefs.fontSize,
              lineHeight: prefs.lineHeight,
              transition: "transform .25s ease",
              transform: `translateX(-${page * (w + 48)}px)`,
            }}
          >
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
          </div>
        ) : (
          <div className={`flex h-full items-center justify-center text-sm ${theme.sub}`}>
            {error ? (
              <div className="text-center">
                <p className="mb-3">{error}</p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setTick((t) => t + 1); // 重试
                  }}
                  className="rounded-lg bg-neutral-700 px-4 py-2 text-sm"
                >
                  重试
                </button>
              </div>
            ) : (
              "加载中…"
            )}
          </div>
        )}
      </div>

      {/* 页码指示 */}
      {ch && (
        <div className={`pointer-events-none pb-2 text-center text-xs ${theme.sub}`} onClick={(e) => e.stopPropagation()}>
          {page + 1}/{pages} · {ch.title}
        </div>
      )}

      {/* 占位提示 toast */}
      {ch?.isPlaceholder && !menu && (
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs text-white" onClick={(e) => e.stopPropagation()}>
          本章疑似占位内容，可在菜单中刷新
        </div>
      )}
      {toast && <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100">{toast}</div>}

      {/* 菜单 */}
      {menu && (
        <div className="absolute inset-x-0 bottom-0 top-0 z-40" onClick={(e) => e.stopPropagation()}>
          <div className={`flex items-center gap-3 px-4 py-3 ${theme.bg} ${theme.text}`}>
            <Link to={`/book/${bookId}`} className="text-sm opacity-70 hover:opacity-100">← 返回</Link>
            <span className="truncate text-sm opacity-70">{ch?.title}</span>
          </div>
          <div className={`absolute inset-x-0 bottom-0 space-y-3 px-4 pb-6 pt-4 ${theme.bg} ${theme.text}`}>
            {/* 进度滑杆：整本书 */}
            <div className="flex items-center gap-2 text-xs">
              <span className="opacity-60">{chapters[0]?.title.slice(0, 6) || ""}</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, chapters.length - 1)}
                value={idx}
                onChange={(e) => goChapter(Number(e.target.value))}
                className="flex-1 accent-amber-500"
              />
              <span className="opacity-60">{chapters.length ? `${idx + 1}/${chapters.length}` : ""}</span>
            </div>
            <div className="flex items-center justify-between">
              <button onClick={() => goChapter(idx - 1)} className="rounded-lg bg-black/20 px-3 py-2 text-sm">上一章</button>
              <button onClick={() => turn(-1)} className="rounded-lg bg-black/20 px-3 py-2 text-sm">上一页</button>
              <button onClick={() => turn(1)} className="rounded-lg bg-black/20 px-3 py-2 text-sm">下一页</button>
              <button onClick={() => goChapter(idx + 1)} className="rounded-lg bg-black/20 px-3 py-2 text-sm">下一章</button>
            </div>
            <div className="flex items-center justify-between">
              <div className="relative">
                <button onClick={refreshCh} className="rounded-lg bg-black/20 px-3 py-2 text-sm">
                  ↻ 刷新
                  {ch?.isPlaceholder && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500" />}
                </button>
              </div>
              <button onClick={toggleTts} className={`rounded-lg bg-black/20 px-3 py-2 text-sm ${speaking ? "text-amber-400" : ""}`}>
                {speaking ? "⏸ 停止朗读" : "🔊 朗读"}
              </button>
              <button onClick={() => setShowSettings((v) => !v)} className="rounded-lg bg-black/20 px-4 py-2 text-sm">Aa</button>
            </div>
            {showSettings && (
              <div className="space-y-3 rounded-xl bg-black/30 p-3 text-sm">
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
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
