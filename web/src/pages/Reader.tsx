import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmtLatest } from "../api";

interface ContentResp {
  idx: number;
  title: string;
  content: string;
  isPlaceholder: boolean;
  cached: boolean;
}
type ThemeId = "dark" | "paper" | "black" | "star" | "green" | "gray" | "custom";
interface Prefs {
  fontSize: number;
  lineHeight: number;
  theme: ThemeId;
  customColor?: string; // 自定义主题色（hex）
  customAlpha?: number; // 自定义透明度 0.2-1
  rate?: number; // TTS 语速 0.5-1.5
  voiceURI?: string; // TTS 发音人
}
interface ThemeSpec {
  bg: string;
  text: string;
  sub: string;
  dark: boolean;
}

const PRESETS: Record<Exclude<ThemeId, "custom">, { name: string; spec: ThemeSpec }> = {
  dark: { name: "暗色", spec: { bg: "#171717", text: "#e5e5e5", sub: "rgba(229,229,229,.45)", dark: true } },
  paper: { name: "羊皮纸", spec: { bg: "#f5efdc", text: "#3b3021", sub: "rgba(59,48,33,.55)", dark: false } },
  black: { name: "纯黑", spec: { bg: "#000000", text: "#a3a3a3", sub: "rgba(163,163,163,.45)", dark: true } },
  star: { name: "星空蓝", spec: { bg: "#141f33", text: "#c7d3e8", sub: "rgba(199,211,232,.5)", dark: true } },
  green: { name: "护眼绿", spec: { bg: "#cfe6cf", text: "#2b3a2c", sub: "rgba(43,58,44,.55)", dark: false } },
  gray: { name: "柔和灰", spec: { bg: "#e4e4e1", text: "#3a3a3a", sub: "rgba(58,58,58,.55)", dark: false } },
};

const hex2rgb = (hex: string) => {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const v = parseInt(n.slice(0, 6), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
};

// 自定义主题：按「颜色亮度 × 透明度」与黑底混合后的亮度决定文字用亮色还是暗色
const resolveTheme = (p: Prefs): ThemeSpec => {
  if (p.theme !== "custom" || !p.customColor) return PRESETS[p.theme]?.spec ?? PRESETS.dark.spec;
  const { r, g, b } = hex2rgb(p.customColor);
  const a = Math.min(Math.max(p.customAlpha ?? 1, 0.2), 1);
  const lum = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * a;
  const dark = lum < 0.5;
  return {
    bg: `rgba(${r},${g},${b},${a})`,
    text: dark ? "#e5e5e5" : "#333333",
    sub: dark ? "rgba(229,229,229,.5)" : "rgba(51,51,51,.55)",
    dark,
  };
};

const loadPrefs = (): Prefs => {
  try {
    const p = { fontSize: 18, lineHeight: 1.7, theme: "dark" as ThemeId, ...JSON.parse(localStorage.getItem("reader-prefs") ?? "{}") };
    p.rate = Math.min(Math.max(p.rate ?? 1, 0.5), 1.5); // 语速范围收口 0.5-1.5
    return p;
  } catch {
    return { fontSize: 18, lineHeight: 1.7, theme: "dark" as ThemeId };
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
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

// 图标+文字（左 icon 右文字，手机顶栏 / PC 左栏）
const NavItem = ({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) => (
  <button onClick={onClick} className="flex items-center gap-1.5 px-2 py-1.5 opacity-75 transition-opacity hover:opacity-100">
    <Icon name={icon} size={17} />
    <span className="text-xs leading-none">{label}</span>
  </button>
);
// 纯图标悬浮钮（title 提示；可传入底色描边样式，暗色主题下也看得清）
const FloatBtn = ({ icon, title, onClick, active, style }: { icon: string; title: string; onClick: () => void; active?: boolean; style?: React.CSSProperties }) => (
  <button
    onClick={onClick}
    title={title}
    style={style}
    className={`flex h-10 w-10 items-center justify-center rounded-full transition-opacity hover:opacity-100 ${active ? "text-amber-500 opacity-100" : "opacity-75"}`}
  >
    <Icon name={icon} size={19} />
  </button>
);

// 设置面板控制按钮：半透明黑底+浅描边，暗色主题下也不和文字混在一起
const CTRL = "rounded border px-3 py-1 text-sm leading-5";
const ctrlStyle = { background: "rgba(0,0,0,.35)", borderColor: "rgba(255,255,255,.15)" };

// 分句：按中文/西文句末标点切，标点与后置引号跟随前句（朗读与高亮都以句为单位）
const SENT_RE = /[^。！？!?…]+[。！？!?…]*[”’"'」』）)]*/g;
const splitSentences = (text: string): string[] => {
  const out = (text.match(SENT_RE) ?? []).filter((s) => s.trim());
  return out.length ? out : [text];
};

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
  const [chrome, setChrome] = useState(false); // 阅读界面按钮/栏默认隐藏，点击正文切换显示
  const [speaking, setSpeaking] = useState(false);
  const [toast, setToast] = useState("");
  const [tick, setTick] = useState(0); // 错误重试触发器
  // —— 换源面板：只列出拥有这本书的源 ——
  const [showSources, setShowSources] = useState(false);
  const [bookName, setBookName] = useState("");
  const [srcList, setSrcList] = useState<{ sourceId: number; sourceName: string; name: string; author: string; bookUrl: string; latestChapter: string; current: boolean }[]>([]);
  const [srcSearching, setSrcSearching] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [srcErr, setSrcErr] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollFrac, setScrollFrac] = useState(0); // 章内滚动比例 0-1（底部细线进度实时用）
  const lastSent = useRef<{ idx: number; pct: number }>({ idx: -1, pct: -1 }); // 上次已上报的进度（去重用）
  const preloaded = useRef<Map<number, ContentResp>>(new Map());
  const firstLoad = useRef(true); // 只有首次进入阅读器才恢复上次进度，章节间跳转一律回到开头
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [spoken, setSpoken] = useState<{ p: number; s: number } | null>(null); // 正在朗读的句子（段落下标 + 句下标）
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([]); // 段落节点：朗读从当前可视段落开始
  const ttsStopped = useRef(false); // 用户停止 / 切章打断标志（避免 cancel 触发的 onend 继续往下读）
  const autoNext = useRef(false); // 本章读完 → 自动续读下一章

  // TTS 发音人列表（浏览器异步加载）
  useEffect(() => {
    if (!window.speechSynthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // 只保留中文发音人（zh-CN / zh-TW / zh-HK …）；已保存的旧值不是中文时清掉，避免选中项对不上列表
  const zhVoices = useMemo(() => voices.filter((v) => /^zh/i.test(v.lang)), [voices]);
  useEffect(() => {
    if (!voices.length) return;
    if (prefs.voiceURI && !zhVoices.some((v) => v.voiceURI === prefs.voiceURI)) setPrefs((p) => ({ ...p, voiceURI: undefined }));
  }, [voices.length, zhVoices.length]);

  useEffect(() => localStorage.setItem("reader-prefs", JSON.stringify(prefs)), [prefs]); // 设置持久化到浏览器
  const theme = resolveTheme(prefs);
  // 正文段落：渲染与朗读共用同一份切片，索引一一对应（paraRefs[i] ↔ paras[i]）
  const paras = useMemo(() => (ch ? ch.content.split("\n").filter((p) => p.trim()) : []), [ch]);
  // 每段再切分句（朗读粒度 = 高亮粒度）
  const paraSents = useMemo(() => paras.map(splitSentences), [paras]);

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
    setScrollFrac(0);
    // 进度上报：进章/跳章立即发一次；阅读中由定时器比对、有变化才发
    const report = (pct: number) => {
      lastSent.current = { idx, pct };
      api(`/api/books/${bookId}/progress`, { method: "PUT", body: JSON.stringify({ chapterIdx: idx, scrollPos: pct }) }).catch(() => {});
    };
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
            report(p); // 进章立即上报一次进度
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = ((el.scrollHeight - el.clientHeight) * Math.min(p, 100)) / 100;
            });
          })
          .catch(() => {});
      } else {
        // 章节间跳转：直接回到开头
        report(0); // 跳章立即上报一次进度
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
      ttsStopped.current = true; // 切章/卸载：打断朗读，且不让 onend 继续读旧章
      window.speechSynthesis?.cancel();
      setSpeaking(false);
      setSpoken(null);
    };
  }, [idx, bookId, tick]);

  // 滚动 → 细线进度实时跟随（进度上报由下方定时器统一处理，滚动本身不发请求）
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollFrac(max > 0 ? el.scrollTop / max : 0);
  };

  // 阅读中定时比对进度（5s），有变化才上报；进章/跳章的立即上报在加载 effect 里
  useEffect(() => {
    const timer = setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      const pct = max > 0 ? Math.round((el.scrollTop / max) * 1000) / 10 : 0;
      if (lastSent.current.idx !== idx || Math.abs(pct - lastSent.current.pct) >= 0.5) {
        lastSent.current = { idx, pct };
        api(`/api/books/${bookId}/progress`, { method: "PUT", body: JSON.stringify({ chapterIdx: idx, scrollPos: pct }) }).catch(() => {});
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [idx, bookId]);

  // 当前书名（换源搜索关键词）
  useEffect(() => {
    api<{ name: string; author: string }>(`/api/books/${bookId}`)
      .then((b) => setBookName(b.name))
      .catch(() => {});
  }, [bookId]);

  // 换源候选：后端并发搜索全部启用源，返回拥有此书的源列表
  const openSources = async () => {
    setShowSources(true);
    setSrcErr("");
    setSrcList([]);
    setSrcSearching(true);
    try {
      setSrcList(await api(`/api/books/${bookId}/sources`));
    } catch (e: any) {
      setSrcErr(e.message);
    } finally {
      setSrcSearching(false);
    }
  };
  // 确认换源：保留进度，重抓目录，超出新目录的章节回第 0 章
  const switchSource = async (h: { sourceId: number; sourceName: string; name: string; bookUrl: string }) => {
    if (!confirm(`换源到「${h.sourceName}」的《${h.name}》？\n进度保留，目录将重新抓取。`)) return;
    setSwitching(true);
    setSrcErr("");
    try {
      await api(`/api/books/${bookId}/source`, { method: "PUT", body: JSON.stringify({ sourceId: h.sourceId, bookUrl: h.bookUrl }) });
      preloaded.current.clear();
      const cat = await api<{ chapters: { idx: number }[] }>(`/api/books/${bookId}/category`);
      setChapters(cat.chapters as any);
      setShowSources(false);
      setToast(`已换源：${h.sourceName}`);
      const to = idx < cat.chapters.length ? idx : 0;
      if (to !== idx) nav(`/book/${bookId}/read/${to}`);
      else setTick((t) => t + 1); // 重载当前章
    } catch (e: any) {
      setSrcErr(e.message);
    } finally {
      setSwitching(false);
    }
  };

  const goChapter = (to: number) => {
    if (to < 0 || (chapters.length && to >= chapters.length)) return setToast(chapters.length ? "没有更多章节" : "");
    // 章节切换用 replace：否则历史里堆满章节，返回键变成「上一章」而不是上一路由
    nav(`/book/${bookId}/read/${to}`, { replace: true });
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

  // —— TTS：按句链式朗读 ——
  const stopTts = () => {
    ttsStopped.current = true;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setSpoken(null);
  };

  // 当前可视位置对应的段落下标（与底部细线同源：以滚动位置为准）
  const currentParaIndex = () => {
    const el = scrollRef.current;
    if (!el) return 0;
    const viewTop = el.getBoundingClientRect().top + 8;
    for (let i = 0; i < paras.length; i++) {
      const p = paraRefs.current[i];
      if (!p) continue;
      if (p.getBoundingClientRect().bottom > viewTop) return i; // 第一个「还没被划过去」的段落
    }
    return Math.max(0, paras.length - 1);
  };

  // 从第 start 段开始读（句粒度）；读完本章且有下一章 → 自动跳过去接着读
  const speakFrom = (start: number) => {
    const synth = window.speechSynthesis;
    if (!synth || !paras.length) return;
    ttsStopped.current = false;
    const voice = zhVoices.find((v) => v.voiceURI === prefs.voiceURI) ?? null;
    // 展平成句子队列：{p 段落下标, s 句下标, text}
    const queue: { p: number; s: number; text: string }[] = [];
    paraSents.forEach((ss, p) => ss.forEach((text, s) => queue.push({ p, s, text })));
    let i = queue.findIndex((it) => it.p >= start);
    if (i < 0) i = queue.length;
    const speakNext = () => {
      if (ttsStopped.current) return;
      if (i >= queue.length) {
        setSpeaking(false);
        setSpoken(null);
        if (chapters.some((c) => c.idx === idx + 1)) {
          autoNext.current = true; // 新章正文就绪后从第一段继续
          nav(`/book/${bookId}/read/${idx + 1}`, { replace: true });
        } else {
          setToast("已读完本书最后一章");
        }
        return;
      }
      const cur = queue[i++];
      setSpoken({ p: cur.p, s: cur.s }); // 高亮正在朗读的句子
      const u = new SpeechSynthesisUtterance(cur.text);
      u.lang = voice?.lang ?? "zh-CN";
      if (voice) u.voice = voice;
      u.rate = prefs.rate ?? 1;
      u.onend = speakNext;
      u.onerror = () => {
        if (!ttsStopped.current) {
          setSpeaking(false);
          setSpoken(null);
        }
      };
      synth.speak(u);
    };
    setSpeaking(true);
    speakNext();
  };

  const toggleTts = () => {
    if (!window.speechSynthesis) return setToast("浏览器不支持语音合成");
    if (speaking) return stopTts();
    if (!ch) return;
    speakFrom(currentParaIndex()); // 从当前阅读位置开始，而不是从头
  };

  // 自动续读：新章正文就绪后从第一段接着读
  useEffect(() => {
    if (!ch || !autoNext.current) return;
    autoNext.current = false;
    const t = setTimeout(() => speakFrom(0), 250);
    return () => clearTimeout(t);
  }, [ch]);

  // 朗读跟读：当前句所在段落滚出视野时才滚动（避免与用户手动滚动打架）
  useEffect(() => {
    if (!spoken) return;
    const el = scrollRef.current;
    const p = paraRefs.current[spoken.p];
    if (!el || !p) return;
    const box = el.getBoundingClientRect();
    const r = p.getBoundingClientRect();
    if (r.top < box.top + 48 || r.bottom > box.bottom - 48) {
      el.scrollTo({ top: el.scrollTop + (r.top - box.top) - box.height * 0.3, behavior: "smooth" });
    }
  }, [spoken]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const bookPct = chapters.length ? `${Math.round(((idx + 1) / chapters.length) * 1000) / 10}%` : "";
  // 底部细线 = 章内滚动进度（滚到底 100%），纯前端派生不同步后端；章节进度在底栏文字里
  const linePct = Math.min(scrollFrac * 100, 100);
  // 浮动圆钮底色：暗色主题黑底、亮色主题白底，避免图标与背景混在一起
  const floatBtnStyle: React.CSSProperties = {
    background: theme.dark ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.65)",
    border: "1px solid rgba(128,128,128,.28)",
  };

  return (
    <div className="fixed inset-0" style={{ background: theme.bg, color: theme.text }}>
      {/* 正文铺满全屏（不随工具栏显隐移动，避免阅读中内容跳动）；点击切换工具栏；PC 固定 640px */}
      <div ref={scrollRef} onScroll={onScroll} onClick={() => setChrome((v) => !v)} className="no-scrollbar absolute inset-0 overflow-y-auto">
        <div className="mx-auto px-4 pt-16 pb-24 max-[500px]:px-5 min-[501px]:w-[640px] min-[501px]:pt-6 min-[501px]:pb-16" style={{ fontSize: prefs.fontSize, lineHeight: prefs.lineHeight }}>
          {ch ? (
            <>
              <h2 className="mb-4 font-bold" style={{ fontSize: prefs.fontSize + 4 }}>
                {ch.title}
              </h2>
              {paras.map((p, i) => (
                <p key={i} ref={(el) => { paraRefs.current[i] = el; }} className="mb-3 indent-8">
                  {/* 朗读中：整段按句切分，当前句用黄色标出 */}
                  {spoken?.p === i
                    ? paraSents[i].map((s, j) => (
                        <span
                          key={j}
                          style={j === spoken.s ? { color: theme.dark ? "#fbbf24" : "#b45309" } : undefined}
                          className={j === spoken.s ? "rounded bg-amber-400/15" : undefined}
                        >
                          {s}
                        </span>
                      ))
                    : p}
                </p>
              ))}
              <div className="mt-8 text-center text-xs" style={{ color: theme.sub }}>— 本章完 · 下一章继续 —</div>
            </>
          ) : (
            <div className="flex h-[60vh] items-center justify-center text-sm" style={{ color: theme.sub }}>
              {error ? (
                <div className="text-center" onClick={(e) => e.stopPropagation()}>
                  <p className="mb-3">{error}</p>
                  <button onClick={() => setTick((t) => t + 1)} className="rounded-lg bg-black/30 px-4 py-2 text-sm">
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

      {/* 以下全部悬浮定位（absolute），显隐不影响正文布局 */}

      {/* 手机顶栏：默认隐藏，点击正文切换；左 icon 右文字；返回=上一个路由 */}
      {chrome && (
        <div className="absolute inset-x-0 top-0 z-30 flex items-center gap-0.5 border-b px-1 py-1.5 backdrop-blur-sm min-[501px]:hidden" style={{ background: theme.bg, borderColor: "rgba(128,128,128,.25)" }}>
          <button onClick={() => nav(-1)} className="flex h-9 w-9 flex-none items-center justify-center opacity-75 hover:opacity-100" title="返回上一页">
            <Icon name="back" size={18} />
          </button>
          <NavItem icon="home" label="首页" onClick={() => nav("/")} />
          <NavItem icon="shelf" label="书架" onClick={() => nav("/")} />
          <NavItem icon="globe" label="书源" onClick={openSources} />
          <NavItem icon="list" label="目录" onClick={() => setShowToc(true)} />
        </div>
      )}

      {/* PC 左栏：≥900px 时紧贴正文左缘（留 12px 间隙），窄视口退回贴窗口边 */}
      {chrome && (
        <div className="absolute left-1 top-3 z-30 hidden min-[501px]:flex min-[501px]:flex-col min-[501px]:items-start min-[501px]:gap-2 min-[900px]:left-[calc(50%-320px)] min-[900px]:-translate-x-[calc(100%+12px)]">
          <NavItem icon="home" label="首页" onClick={() => nav("/")} />
          <NavItem icon="shelf" label="书架" onClick={() => nav("/")} />
          <NavItem icon="globe" label="书源" onClick={openSources} />
          <NavItem icon="list" label="目录" onClick={() => setShowToc(true)} />
        </div>
      )}

      {/* PC 右栏：≥900px 时紧贴正文右缘（留 12px 间隙） */}
      {chrome && (
        <div className="absolute bottom-3 right-1 z-30 hidden min-[501px]:flex min-[501px]:flex-col min-[501px]:items-end min-[501px]:gap-3 min-[900px]:right-auto min-[900px]:left-[calc(50%+320px)] min-[900px]:translate-x-[12px]">
          <FloatBtn icon="book" title="书籍详情" onClick={() => nav(`/book/${bookId}`)} style={floatBtnStyle} />
          <FloatBtn icon="refresh" title="刷新本章" onClick={refreshCh} style={floatBtnStyle} />
          <FloatBtn icon="speak" title={speaking ? "停止朗读" : "朗读"} onClick={toggleTts} active={speaking} style={floatBtnStyle} />
          <FloatBtn icon="settings" title="设置" onClick={() => setShowSettings(true)} style={floatBtnStyle} />
        </div>
      )}

      {/* 手机左侧悬浮：书籍详情 / 缓存下载（半透明底色，暗色主题下也看得清） */}
      {chrome && (
        <div className="absolute bottom-20 left-1 z-40 flex flex-col gap-3 min-[501px]:hidden">
          <FloatBtn icon="book" title="书籍详情" onClick={() => nav(`/book/${bookId}`)} style={floatBtnStyle} />
          <FloatBtn icon="download" title="缓存下载" onClick={cacheAll} style={floatBtnStyle} />
        </div>
      )}
      {/* 手机右侧悬浮：刷新 / 朗读 / 设置（设置入口在右侧按钮组，底栏不放） */}
      {chrome && (
        <div className="absolute bottom-20 right-1 z-40 flex flex-col gap-3 min-[501px]:hidden">
          <FloatBtn icon="refresh" title="刷新本章" onClick={refreshCh} style={floatBtnStyle} />
          <FloatBtn icon="speak" title={speaking ? "停止朗读" : "朗读"} onClick={toggleTts} active={speaking} style={floatBtnStyle} />
          <FloatBtn icon="settings" title="设置" onClick={() => setShowSettings(true)} style={floatBtnStyle} />
        </div>
      )}

      {/* PC 底部：上一章 · 进度 · 下一章（悬浮） */}
      {chrome && (
        <div className="absolute inset-x-0 bottom-0 z-30 hidden items-center justify-center gap-8 border-t bg-inherit py-2 text-xs min-[501px]:flex max-[500px]:hidden backdrop-blur-sm" style={{ color: theme.sub, borderColor: "rgba(128,128,128,.2)", background: theme.bg }}>
          <button onClick={() => goChapter(idx - 1)} className="px-3 py-1 opacity-75 transition-opacity hover:opacity-100">上一章</button>
          <span className="min-w-16 text-center">{chapters.length ? `${idx + 1}/${chapters.length} · ${bookPct}` : ""}</span>
          <button onClick={() => goChapter(idx + 1)} className="px-3 py-1 opacity-75 transition-opacity hover:opacity-100">下一章</button>
        </div>
      )}

      {/* 手机底栏：上一章 · 章节进度 · 下一章（设置入口在右侧浮动按钮组） */}
      {chrome && (
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-around border-t px-2 py-2 backdrop-blur-sm min-[501px]:hidden" style={{ background: theme.bg, borderColor: "rgba(128,128,128,.25)" }}>
          <button onClick={() => goChapter(idx - 1)} className="px-4 py-1.5 text-sm opacity-80 hover:opacity-100">上一章</button>
          <span className="min-w-14 text-center text-xs opacity-60">{bookPct}</span>
          <button onClick={() => goChapter(idx + 1)} className="px-4 py-1.5 text-sm opacity-80 hover:opacity-100">下一章</button>
        </div>
      )}

      {/* 底部细线进度：章内滚动进度（滚到底 100%），常驻显示（不受菜单显隐影响，不同步后端） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-50 h-0.5" style={{ background: "rgba(128,128,128,.2)" }}>
        <div className="h-full transition-[width] duration-150" style={{ width: `${linePct}%`, background: "rgba(245,158,11,.85)" }} />
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
          <div className="mx-auto min-h-full min-[501px]:w-[640px] max-w-full p-4" style={{ background: theme.bg, color: theme.text }} onClick={(e) => e.stopPropagation()}>
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

      {/* 换源面板：后端并发搜全部启用源，只列拥有这本书的源，点击即换 */}
      {showSources && (
        <div className="absolute inset-0 z-40 overflow-y-auto bg-black/60" onClick={() => !switching && setShowSources(false)}>
          <div className="mx-auto min-h-full min-[501px]:w-[640px] max-w-full p-4" style={{ background: theme.bg, color: theme.text }} onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 mb-2 flex items-center gap-2 bg-inherit pb-2 pt-1">
              <h3 className="text-sm font-bold">换源</h3>
              <span className="truncate text-xs opacity-50">《{bookName || "…"}》</span>
              <button onClick={() => setShowSources(false)} className="ml-auto px-2 text-lg opacity-60 hover:opacity-100">×</button>
            </div>
            {(srcSearching || switching) && <div className="py-1 text-center text-xs opacity-60">{srcSearching ? "正在所有书源中搜索这本书…" : "正在换源…"}</div>}
            {srcErr && <div className="mb-2 rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-400">{srcErr}</div>}
            <div className="divide-y" style={{ borderColor: "rgba(128,128,128,.2)" }}>
              {srcList.map((h) => (
                <button
                  key={h.sourceId}
                  onClick={() => switchSource(h)}
                  disabled={switching || h.current}
                  className="block w-full py-2.5 text-left text-sm hover:opacity-100 disabled:opacity-50"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium opacity-90">{h.sourceName}</span>
                    {h.current && <span className="rounded bg-amber-500 px-1.5 text-[10px] font-medium text-neutral-900">当前</span>}
                    {h.name === bookName ? <span className="text-xs text-amber-400">《{h.name}》</span> : <span className="text-xs opacity-60">《{h.name}》</span>}
                  </div>
                  <div className="mt-0.5 truncate text-xs opacity-50">
                    {h.author || "佚名"}
                    {h.latestChapter ? ` · 最新：${fmtLatest(h.latestChapter)}` : ""}
                  </div>
                </button>
              ))}
              {!srcList.length && !srcSearching && !srcErr && <div className="py-6 text-center text-sm opacity-50">没有其他源收录这本书</div>}
            </div>
          </div>
        </div>
      )}

      {/* 设置弹层：字号/行距/主题/语速/发音人，全部实时持久化到 localStorage */}
      {showSettings && (
        <div className="absolute inset-0 z-40 bg-black/50" onClick={() => setShowSettings(false)}>
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl p-4 pb-8" style={{ background: theme.bg, color: theme.text, borderTop: "1px solid rgba(128,128,128,.35)" }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center">
              <h3 className="text-sm font-bold">设置</h3>
              <button onClick={() => setShowSettings(false)} className="ml-auto px-2 text-lg opacity-60 hover:opacity-100">×</button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3">
                <span className="w-14 opacity-60">字号</span>
                <button onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.max(14, p.fontSize - 2) }))} className={CTRL} style={ctrlStyle}>A-</button>
                <span className="w-7 text-center">{prefs.fontSize}</span>
                <button onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.min(30, p.fontSize + 2) }))} className={CTRL} style={ctrlStyle}>A+</button>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 opacity-60">行距</span>
                <button onClick={() => setPrefs((p) => ({ ...p, lineHeight: Math.max(1.4, Math.round((p.lineHeight - 0.1) * 10) / 10) }))} className={CTRL} style={ctrlStyle}>−</button>
                <span className="w-9 text-center">{prefs.lineHeight.toFixed(1)}</span>
                <button onClick={() => setPrefs((p) => ({ ...p, lineHeight: Math.min(2.4, Math.round((p.lineHeight + 0.1) * 10) / 10) }))} className={CTRL} style={ctrlStyle}>＋</button>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-14 flex-none pt-1.5 opacity-60">主题</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setPrefs((p) => ({ ...p, theme: t }))}
                      className={`rounded-lg px-2.5 py-1 text-xs ${prefs.theme === t ? "ring-2 ring-amber-400" : ""}`}
                      style={{ background: PRESETS[t].spec.bg, color: PRESETS[t].spec.text }}
                    >
                      {PRESETS[t].name}
                    </button>
                  ))}
                  <button
                    onClick={() => setPrefs((p) => ({ ...p, theme: "custom" }))}
                    className={`rounded-lg px-2.5 py-1 text-xs ${prefs.theme === "custom" ? "bg-amber-500/90 text-neutral-900 ring-2 ring-amber-400" : "text-neutral-300"}`}
                    style={prefs.theme === "custom" ? undefined : { background: "rgba(0,0,0,.35)" }}
                  >
                    自定义
                  </button>
                </div>
              </div>
              {prefs.theme === "custom" && (
                <div className="flex items-center gap-3">
                  <span className="w-14 flex-none opacity-60">颜色</span>
                  <input
                    type="color"
                    value={prefs.customColor ?? "#1a2b4c"}
                    onChange={(e) => setPrefs((p) => ({ ...p, customColor: e.target.value }))}
                    className="h-8 w-12 flex-none cursor-pointer rounded border p-0.5"
                    style={{ background: "rgba(0,0,0,.35)", borderColor: "rgba(255,255,255,.15)" }}
                  />
                  <input
                    type="range"
                    min={0.2}
                    max={1}
                    step={0.05}
                    value={prefs.customAlpha ?? 1}
                    onChange={(e) => setPrefs((p) => ({ ...p, customAlpha: Number(e.target.value) }))}
                    className="min-w-0 flex-1 accent-amber-500"
                  />
                  <span className="w-16 flex-none text-right text-xs opacity-70">{Math.round((prefs.customAlpha ?? 1) * 100)}%</span>
                </div>
              )}
              <div className="flex items-center gap-3">
                <span className="w-14 opacity-60">语速</span>
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.1}
                  value={prefs.rate ?? 1}
                  onChange={(e) => setPrefs((p) => ({ ...p, rate: Number(e.target.value) }))}
                  className="min-w-0 flex-1 accent-amber-500"
                />
                <span className="w-10 flex-none text-right">{(prefs.rate ?? 1).toFixed(1)}x</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 flex-none opacity-60">发音人</span>
                <select
                  value={prefs.voiceURI ?? ""}
                  onChange={(e) => setPrefs((p) => ({ ...p, voiceURI: e.target.value }))}
                  className="min-w-0 flex-1 rounded px-2 py-1.5 text-xs"
                  style={{ background: "rgba(0,0,0,.35)", color: "inherit" }}
                >
                  <option value="">系统默认</option>
                  {zhVoices.map((v) => (
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
