import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmtLatest } from "../api";
import { useConfirm } from "../Confirm";
import { holdAudioSession, releaseAudioSession } from "../tts-audio";

interface ContentResp {
  idx: number;
  title: string;
  content: string;
  isPlaceholder: boolean;
  cached: boolean;
}
type ThemeId = "dark" | "paper" | "star" | "green" | "gray";
interface Prefs {
  fontSize: number;
  lineHeight: number;
  theme: ThemeId;
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
  star: { name: "星空蓝", spec: { bg: "#141f33", text: "#c7d3e8", sub: "rgba(199,211,232,.5)", dark: true } },
  green: { name: "护眼绿", spec: { bg: "#cfe6cf", text: "#2b3a2c", sub: "rgba(43,58,44,.55)", dark: false } },
  gray: { name: "柔和灰", spec: { bg: "#e4e4e1", text: "#3a3a3a", sub: "rgba(58,58,58,.55)", dark: false } },
};

// 主题：5 个预设；历史遗留的 custom/纯黑等已下线取值统一落到暗色
const resolveTheme = (p: Prefs): ThemeSpec => {
  return PRESETS[p.theme]?.spec ?? PRESETS.dark.spec;
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
// spinning：耗时操作进行中，图标原地匀速旋转（如刷新本章），并禁用重复点击
const FloatBtn = ({ icon, title, onClick, active, spinning, style }: { icon: string; title: string; onClick: () => void; active?: boolean; spinning?: boolean; style?: React.CSSProperties }) => (
  <button
    onClick={onClick}
    title={title}
    style={style}
    disabled={spinning}
    className={`flex h-10 w-10 items-center justify-center rounded-full transition-opacity hover:opacity-100 ${active ? "text-amber-500 opacity-100" : "opacity-75"}`}
  >
    <span className={`block ${spinning ? "animate-spin" : ""}`}>
      <Icon name={icon} size={19} />
    </span>
  </button>
);

// 弹层关闭按钮（目录/换源/设置共用）：移动端「点透」修复——点击卸载弹层后，同一次点按的
// 合成 click 会落到弹层下方的元素上（目录场景 = 正下方那行章节 → 直接跳章）。
// touchend 阶段 preventDefault 吞掉合成 click；手位移 >10px 视为滚动收尾，不当作点按。
const SheetClose = ({ onClose }: { onClose: () => void }) => {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <button
      onTouchStart={(e) => {
        const t = e.touches[0];
        start.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(e) => {
        const t = e.changedTouches[0];
        const s = start.current;
        start.current = null;
        if (!s || Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) return;
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="ml-auto px-2 text-lg opacity-60 hover:opacity-100"
    >
      ×
    </button>
  );
};

// 设置面板控制按钮：半透明黑底+浅描边，暗色主题下也不和文字混在一起
const CTRL = "rounded border px-3 py-1 text-sm leading-5";
const ctrlStyle = { background: "rgba(0,0,0,.35)", borderColor: "rgba(255,255,255,.15)" };

// 分句：按中文/西文句末标点切，标点与后置引号跟随前句（朗读与高亮都以句为单位）
const SENT_RE = /[^。！？!?…]+[。！？!?…]*[”’"'」』）)]*/g;
const splitSentences = (text: string): string[] => {
  const out = (text.match(SENT_RE) ?? []).filter((s) => s.trim());
  return out.length ? out : [text];
};

// 可选发音人：只要中文；排除 iOS 内置 Eloquence 系列（机械音明显，体验差）。
// 用户在系统里另外下载的中文发音人（增强版/Siri 声音等）会随 voiceschanged 自动进入列表。
const isZhVoice = (v: SpeechSynthesisVoice) => /^zh/i.test(v.lang) && !/eloquence/i.test(v.voiceURI);

// 同名发音人的区分标签：系统里「婷婷」和「婷婷优化版」是两条不同音质的语音，但 name 可能相同，
// 只有 voiceURI 不同（优化/高级版 URI 里带 enhanced/premium 等标识）——从 URI 提取标签给用户看
const voiceTag = (v: SpeechSynthesisVoice): string => {
  const uri = v.voiceURI.toLowerCase();
  if (uri.includes("enhanced")) return "优化版";
  if (uri.includes("premium")) return "高级版";
  if (uri.includes("siri")) return "Siri";
  if (uri.includes("compact") || uri.includes("ttsbundle")) return "标准版";
  return uri.split(/[.:]/).filter(Boolean).pop() ?? v.voiceURI; // 兜底：URI 最后一段
};

// 阅读器：滚动模式；>500px 为 PC 布局（内容固定宽，左右紧贴工具栏），否则手机布局（顶栏+底栏+两侧悬浮钮）
export default function Reader() {
  const { id, idx: idxParam } = useParams();
  const bookId = Number(id);
  const idx = Number(idxParam);
  const nav = useNavigate();
  const [ask, confirmUi] = useConfirm();

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
  const tocRef = useRef<HTMLDivElement>(null); // 目录弹层滚动容器（当前章居中定位用）
  const curChRef = useRef<HTMLButtonElement>(null); // 目录里「当前章」那一行
  const [refreshing, setRefreshing] = useState(false); // 强制刷新本章中：按钮图标旋转
  const [scrollFrac, setScrollFrac] = useState(0); // 章内滚动比例 0-1（底部细线进度实时用）
  const lastSent = useRef<{ idx: number; pct: number }>({ idx: -1, pct: -1 }); // 上次已上报的进度（去重用）
  const preloaded = useRef<Map<number, ContentResp>>(new Map());
  const firstLoad = useRef(true); // 只有首次进入阅读器才恢复上次进度，章节间跳转一律回到开头
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [spoken, setSpoken] = useState<{ p: number; s: number } | null>(null); // 正在朗读的句子（段落下标 + 句下标）
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([]); // 段落节点：朗读从当前可视段落开始
  const ttsStopped = useRef(false); // 用户停止 / 切章打断标志（避免 cancel 触发的 onend 继续往下读）
  const autoNext = useRef(false); // 本章读完 → 自动续读下一章
  // TTS 引擎卡死自愈（症状：点朗读一直没声音，刷新页面都救不回来，只有重启浏览器才行）
  const curUtter = useRef<SpeechSynthesisUtterance | null>(null); // 持有当前 Utterance 防 GC（Chrome 旧 bug：被提前回收会无声且 onend 不触发）
  const wdt = useRef<ReturnType<typeof setTimeout> | null>(null); // 起播/读句看门狗
  const wdtRetried = useRef(false); // 引擎假死只自动重试一次，仍不行就提示重启浏览器
  const tapGuard = useRef(0); // 弹层关闭后 500ms 内：吞掉同一次点按穿透到下层元素的合成 click（见 closeSheet）
  // 弹层关闭统一入口：记录护栏时间戳。关闭导致弹层卸载后，部分浏览器会把这次点按的
  // 合成 click 重新定位到此刻位于同一坐标的下层元素（目录场景 = 正下方章节行 → 误跳章），
  // preventDefault 在这些场景拦不住，用时间戳在目标侧兜底忽略。
  const closeSheet = (setter: (v: boolean) => void) => () => {
    tapGuard.current = Date.now() + 500;
    setter(false);
  };

  // TTS 发音人列表（浏览器异步加载）
  useEffect(() => {
    if (!window.speechSynthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // 只保留中文发音人（排除 Eloquence）；按 voiceURI 去重防系统返回完全相同的条目；
  // 已保存的旧值不在列表时清掉，避免选中项对不上
  const zhVoices = useMemo(() => {
    const seen = new Set<string>();
    return voices.filter((v) => isZhVoice(v) && !seen.has(v.voiceURI) && seen.add(v.voiceURI));
  }, [voices]);
  // 出现 ≥2 次的名字需要用 URI 标签区分（如「婷婷」与「婷婷优化版」）
  const dupVoiceNames = useMemo(() => {
    const count = new Map<string, number>();
    zhVoices.forEach((v) => count.set(v.name, (count.get(v.name) ?? 0) + 1));
    return new Set([...count].filter(([, n]) => n > 1).map(([name]) => name));
  }, [zhVoices]);

  // 朗读中每造一个 Utterance 都从这里实时读偏好——设置面板改语速/发音人，下一句立即生效
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    voicesRef.current = voices;
  }, [voices]);
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

  // 目录弹层打开时：把「当前章」一行滚到列表竖直中央——目录动辄上千章，落点若停在第 1 章，
  // 想找当前章得手动往下翻很久。依赖 chapters.length，覆盖「先开弹层、目录后到」的异步顺序。
  useEffect(() => {
    if (!showToc || !chapters.length) return;
    const raf = requestAnimationFrame(() => {
      const box = tocRef.current;
      const el = curChRef.current;
      if (!box || !el) return;
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      box.scrollTop += r.top - b.top - (b.height - r.height) / 2; // 行中心 ↔ 容器中心
    });
    return () => cancelAnimationFrame(raf);
  }, [showToc, chapters.length, idx]);

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
      resetTts(); // resume+cancel 复位，防引擎假死
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
    const ok = await ask({
      title: `换源到「${h.sourceName}」的《${h.name}》？`,
      desc: "阅读进度保留，目录会用新源重新抓取。",
      okText: "换源",
      danger: false,
    });
    if (!ok) return;
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

  // 强制刷新本章：绕过缓存重抓正文（?refresh=1）；请求期间按钮图标旋转，防重复点击
  const refreshCh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await api<ContentResp>(`/api/books/${bookId}/content/${idx}?refresh=1`);
      preloaded.current.delete(idx);
      setCh(r);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setToast(r.isPlaceholder ? "已刷新，但仍疑似占位内容" : "已刷新");
    } catch (e: any) {
      setToast(e.message);
    } finally {
      setRefreshing(false);
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
  const clearWatchdog = () => {
    if (wdt.current) {
      clearTimeout(wdt.current);
      wdt.current = null;
    }
  };
  // 引擎复位：先 resume 再 cancel——对 paused 状态的队列直接 cancel 无效，这是「卡住没声音」的常见成因
  const resetTts = () => {
    clearWatchdog();
    curUtter.current = null;
    const synth = window.speechSynthesis;
    if (!synth) return;
    try {
      synth.resume();
      synth.cancel();
    } catch {}
  };

  const stopTts = () => {
    ttsStopped.current = true;
    resetTts();
    releaseAudioSession(); // 停读就归还音频会话
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

  // 从第 startP 段第 startS 句开始读（句粒度）；读完本章且有下一章 → 自动跳过去接着读。
  // 语速/发音人在每句创建 Utterance 时从 prefsRef/voicesRef 实时取，设置改动下一句生效。
  const speakFrom = (startP: number, startS = 0) => {
    const synth = window.speechSynthesis;
    if (!synth || !paras.length) return;
    holdAudioSession(); // iOS：朗读期间把音频会话抬到 playback，静音开关打开也能外放
    ttsStopped.current = false;
    // 展平成句子队列：{p 段落下标, s 句下标, text}
    const queue: { p: number; s: number; text: string }[] = [];
    paraSents.forEach((ss, p) => ss.forEach((text, s) => queue.push({ p, s, text })));
    let i = queue.findIndex((it) => it.p > startP || (it.p === startP && it.s >= startS));
    if (i < 0) i = queue.length;
    const speakNext = () => {
      if (ttsStopped.current) return;
      clearWatchdog();
      if (i >= queue.length) {
        setSpeaking(false);
        setSpoken(null);
        if (chapters.some((c) => c.idx === idx + 1)) {
          autoNext.current = true; // 新章正文就绪后从第一段继续
          // 会话先留着：续读发生在异步回调里，重新抢会话可能拿不到用户手势
          nav(`/book/${bookId}/read/${idx + 1}`, { replace: true });
        } else {
          releaseAudioSession();
          setToast("已读完本书最后一章");
        }
        return;
      }
      const cur = queue[i++];
      setSpoken({ p: cur.p, s: cur.s }); // 高亮正在朗读的句子
      const voice = voicesRef.current.filter(isZhVoice).find((v) => v.voiceURI === prefsRef.current.voiceURI) ?? null;
      const u = new SpeechSynthesisUtterance(cur.text);
      curUtter.current = u; // 持引用防 GC：utterance 被提前回收会无声且 onend 永不触发
      u.lang = voice?.lang ?? "zh-CN";
      if (voice) u.voice = voice;
      u.rate = prefsRef.current.rate ?? 1;
      u.onstart = () => {
        clearWatchdog();
        wdtRetried.current = false; // 引擎已恢复，后续仍可自愈重试
        // 起播后兜底：onend 偶发不触发（Chrome/Safari 老毛病），按文本长度估时，超时自动放行下一句
        wdt.current = setTimeout(() => {
          if (ttsStopped.current) return;
          resetTts();
          speakNext();
        }, Math.max(4000, cur.text.length * 600) / (prefsRef.current.rate ?? 1));
      };
      u.onend = () => {
        if (ttsStopped.current) return;
        clearWatchdog();
        speakNext();
      };
      u.onerror = () => {
        if (!ttsStopped.current) {
          releaseAudioSession();
          setSpeaking(false);
          setSpoken(null);
        }
      };
      synth.resume(); // 解除 paused 卡死；正常状态下无副作用
      synth.speak(u);
      // 起播看门狗：3s 内 onstart 没来 = 引擎假死（点了朗读一直没声音），cancel 后重试本句一次
      wdt.current = setTimeout(() => {
        if (ttsStopped.current) return;
        if (wdtRetried.current) {
          // 重试仍无声：引擎彻底假死，只能提示用户重启浏览器
          releaseAudioSession();
          setSpeaking(false);
          setSpoken(null);
          setToast("语音引擎无响应，请完全退出浏览器后重试");
          return;
        }
        wdtRetried.current = true;
        resetTts();
        i--; // 回退当前句重试
        speakNext();
      }, 3000);
    };
    setSpeaking(true);
    speakNext();
  };

  // 正文里当前选中的文字位置（段落下标 + 句下标）：选中即起点，「从这句开始朗读」
  const selectionStart = (): { p: number; s: number } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const anchor = sel.anchorNode;
    if (!anchor) return null;
    const host = anchor.nodeType === 3 ? anchor.parentElement : (anchor as HTMLElement);
    let p = -1;
    for (let i = 0; i < paraRefs.current.length; i++) {
      if (paraRefs.current[i]?.contains(host ?? null)) {
        p = i;
        break;
      }
    }
    if (p < 0 || !paraRefs.current[p]) return null;
    // 选中起点在段落全文中的偏移 → 落在哪一句
    const range = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(paraRefs.current[p]!);
    pre.setEnd(range.startContainer, range.startOffset);
    const off = pre.toString().length;
    const ss = paraSents[p];
    let acc = 0;
    for (let s = 0; s < ss.length; s++) {
      acc += ss[s].length;
      if (off < acc) return { p, s };
    }
    return { p, s: ss.length - 1 };
  };

  const toggleTts = () => {
    if (!window.speechSynthesis) return setToast("浏览器不支持语音合成");
    if (speaking) return stopTts();
    if (!ch) return;
    const from = selectionStart(); // 有选中文本 → 从选中句开始；否则从当前可视位置开始
    speakFrom(from?.p ?? currentParaIndex(), from?.s ?? 0);
  };

  // 自动续读：新章正文就绪后从第一段接着读
  useEffect(() => {
    if (!ch || !autoNext.current) return;
    autoNext.current = false;
    const t = setTimeout(() => speakFrom(0), 250);
    return () => clearTimeout(t);
  }, [ch]);

  // 离开阅读器：归还音频会话（章节切换不清，因为自动续读还要接着用）
  useEffect(() => () => releaseAudioSession(), []);

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
      {confirmUi}
      {/* 正文铺满全屏（不随工具栏显隐移动，避免阅读中内容跳动）；点击切换工具栏；PC 固定 640px */}
      <div ref={scrollRef} onScroll={onScroll} onClick={() => { if (Date.now() < tapGuard.current) return; setChrome((v) => !v); }} className="no-scrollbar absolute inset-0 overflow-y-auto">
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
              {/* 章末衔接条：点一下等同底部「下一章」（stopPropagation 免得顺带把工具栏切掉） */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goChapter(idx + 1);
                }}
                className="mt-8 block w-full rounded-lg py-3 text-center text-xs transition-opacity hover:opacity-100"
                style={{ color: theme.sub }}
                title="下一章"
              >
                — 本章完 · 下一章继续 —
              </button>
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

      {/* 手机顶栏：默认隐藏，点击正文切换；左 icon 右文字；返回=上一个路由（首页即书架，不设「首页」入口） */}
      {chrome && (
        <div className="absolute inset-x-0 top-0 z-30 flex items-center gap-0.5 border-b px-1 py-1.5 backdrop-blur-sm min-[501px]:hidden" style={{ background: theme.bg, borderColor: "rgba(128,128,128,.25)" }}>
          <button onClick={() => nav(-1)} className="flex h-9 w-9 flex-none items-center justify-center opacity-75 hover:opacity-100" title="返回上一页">
            <Icon name="back" size={18} />
          </button>
          <NavItem icon="shelf" label="书架" onClick={() => nav("/")} />
          <NavItem icon="globe" label="书源" onClick={openSources} />
          <NavItem icon="list" label="目录" onClick={() => setShowToc(true)} />
        </div>
      )}

      {/* PC 左栏：≥900px 时紧贴正文左缘（留 12px 间隙），窄视口退回贴窗口边 */}
      {chrome && (
        <div className="absolute left-1 top-3 z-30 hidden min-[501px]:flex min-[501px]:flex-col min-[501px]:items-start min-[501px]:gap-2 min-[900px]:left-[calc(50%-320px)] min-[900px]:-translate-x-[calc(100%+12px)]">
          <NavItem icon="shelf" label="书架" onClick={() => nav("/")} />
          <NavItem icon="globe" label="书源" onClick={openSources} />
          <NavItem icon="list" label="目录" onClick={() => setShowToc(true)} />
        </div>
      )}

      {/* PC 右栏：≥900px 时紧贴正文右缘（留 12px 间隙）；
          抬到 bottom-14，让开底部「上一章 · 进度 · 下一章」条（约 33px 高），否则设置钮下半截被压住 */}
      {chrome && (
        <div className="absolute bottom-14 right-1 z-30 hidden min-[501px]:flex min-[501px]:flex-col min-[501px]:items-end min-[501px]:gap-3 min-[900px]:right-auto min-[900px]:left-[calc(50%+320px)] min-[900px]:translate-x-[12px]">
          <FloatBtn icon="book" title="书籍详情" onClick={() => nav(`/book/${bookId}`)} style={floatBtnStyle} />
          <FloatBtn icon="refresh" title="刷新本章" onClick={refreshCh} spinning={refreshing} style={floatBtnStyle} />
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
          <FloatBtn icon="refresh" title="刷新本章" onClick={refreshCh} spinning={refreshing} style={floatBtnStyle} />
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

      {/* 目录弹层：头部（标题+关闭）与列表上下排列、列表内部滚动——「×」下面是面板容器而不是章节行，
          从结构上根除点透；打开即把当前章滚到列表中央（tocRef 现在是列表自己的滚动容器） */}
      {showToc && (
        <div className="absolute inset-0 z-40 bg-black/60" onClick={closeSheet(setShowToc)}>
          <div className="mx-auto flex h-full min-[501px]:w-[640px] max-w-full flex-col p-4" style={{ background: theme.bg, color: theme.text }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex flex-none items-center pb-2 pt-1">
              <h3 className="text-sm font-bold">目录</h3>
              <span className="ml-2 text-xs opacity-50">共 {chapters.length} 章</span>
              <SheetClose onClose={closeSheet(setShowToc)} />
            </div>
            <div ref={tocRef} className="flex-1 overflow-y-auto" >
              <div className="divide-y" style={{ borderColor: "rgba(128,128,128,.2)" }}>
                {chapters.map((c) => (
                  <button
                    key={c.idx}
                    ref={c.idx === idx ? curChRef : undefined}
                    onClick={() => {
                      if (Date.now() < tapGuard.current) return; // 保险丝：弹层刚关闭的合成 click 穿透，忽略
                      setShowToc(false);
                      goChapter(c.idx);
                    }}
                    className={`block w-full truncate rounded px-2 py-2.5 text-left text-sm hover:opacity-100 ${c.idx === idx ? "bg-amber-400/10 font-medium text-amber-400" : "opacity-80"}`}
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
        </div>
      )}

      {/* 换源面板：后端并发搜全部启用源，只列拥有这本书的源，点击即换；头部与列表上下排列（同目录弹层，根除点透） */}
      {showSources && (
        <div className="absolute inset-0 z-40 bg-black/60" onClick={() => !switching && closeSheet(setShowSources)()}>
          <div className="mx-auto flex h-full min-[501px]:w-[640px] max-w-full flex-col p-4" style={{ background: theme.bg, color: theme.text }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex flex-none items-center gap-2 pb-2 pt-1">
              <h3 className="text-sm font-bold">换源</h3>
              <span className="truncate text-xs opacity-50">《{bookName || "…"}》</span>
              <SheetClose onClose={closeSheet(setShowSources)} />
            </div>
            {(srcSearching || switching) && <div className="flex-none py-1 text-center text-xs opacity-60">{srcSearching ? "正在所有书源中搜索这本书…" : "正在换源…"}</div>}
            {srcErr && <div className="mb-2 flex-none rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-400">{srcErr}</div>}
            <div className="flex-1 overflow-y-auto">
              <div className="divide-y" style={{ borderColor: "rgba(128,128,128,.2)" }}>
                {srcList.map((h) => (
                  <button
                    key={h.sourceId}
                    onClick={() => {
                      if (Date.now() < tapGuard.current) return; // 保险丝：弹层刚关闭的合成 click 穿透，忽略
                      switchSource(h);
                    }}
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
        </div>
      )}

      {/* 设置弹层：字号/行距/主题/语速/发音人，全部实时持久化到 localStorage；遮罩不加背景色，面板保留主题背景 */}
      {showSettings && (
        <div className="absolute inset-0 z-40" onClick={closeSheet(setShowSettings)}>
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl p-4 pb-8" style={{ background: theme.bg, color: theme.text, borderTop: "1px solid rgba(128,128,128,.35)" }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center">
              <h3 className="text-sm font-bold">设置</h3>
              <SheetClose onClose={closeSheet(setShowSettings)} />
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
                </div>
              </div>
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
                      {v.name}
                      {dupVoiceNames.has(v.name) ? `（${voiceTag(v)}）` : ""}（{v.lang}）{v.localService ? "" : " · 在线"}
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
