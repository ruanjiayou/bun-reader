import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useConfirm } from "../Confirm";

interface SourceRow {
  id: number;
  name: string;
  bookUrl: string;
  group: string;
  enabled: boolean;
  type: string; // rules = 规则表单源；script = class 脚本源
  bookCount?: number; // 该源下已有几本书（后端统计）
}

const Icon = ({
  children,
  size = 18,
  strokeWidth = 2,
}: {
  children: React.ReactNode;
  size?: number;
  strokeWidth?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);
const BackIcon = () => (
  <Icon>
    <polyline points="15 18 9 12 15 6" />
  </Icon>
);
const PlusIcon = () => (
  <Icon size={16}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Icon>
);
// 调试：小虫子（像排查 bug 那样跑一遍这条源的链路）。18px + 细线宽，缩到 16px 腿会糊成一团
const BugIcon = () => (
  <Icon size={18} strokeWidth={1.7}>
    <path d="m8 2 1.88 1.88" />
    <path d="M14.12 3.88 16 2" />
    <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
    <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
    <path d="M12 20v-9" />
    <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
    <path d="M6 13H2" />
    <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
    <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
    <path d="M22 13h-4" />
    <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
  </Icon>
);
const TrashIcon = () => (
  <Icon size={16}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </Icon>
);

// 书源列表：书架 → 书源。点行进入编辑页；行内「调试」直接带 ?tab=debug 打开调试
export default function SourceList() {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [filter, setFilter] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [ask, confirmUi] = useConfirm();

  const load = () => api<SourceRow[]>("/api/sources").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const shown = useMemo(
    () => rows.filter((r) => !filter || r.name.includes(filter) || r.group.includes(filter) || r.bookUrl.includes(filter)),
    [rows, filter],
  );
  const totalBooks = rows.reduce((n, r) => n + (r.bookCount ?? 0), 0);

  const del = async (r: SourceRow) => {
    const ok = await ask({
      title: `删除书源「${r.name}」？`,
      desc:
        r.bookCount && r.bookCount > 0
          ? `该源下已有 ${r.bookCount} 本书。删除书源不会删除书架里的书（章节与正文缓存保留），但这些书之后无法再从该源更新。`
          : "书源配置会被删除，无法撤销。",
      okText: "删除",
    });
    if (!ok) return;
    try {
      await api(`/api/sources/${r.id}`, { method: "DELETE" });
      setMsg(`已删除「${r.name}」`);
      load();
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  const doImportUrl = async () => {
    if (!importUrl.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api<{ added: number; updated: number }>("/api/sources/import", {
        method: "POST",
        body: JSON.stringify({ url: importUrl.trim() }),
      });
      setMsg(`导入完成：新增 ${r.added}，更新 ${r.updated}`);
      setImportUrl("");
      load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const doExport = async () => {
    const data = await api<any[]>("/api/sources/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "legado-sources.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mx-auto min-h-dvh max-w-3xl p-4">
      {confirmUi}
      <header className="mb-3 flex items-center gap-2">
        <button
          onClick={() => nav("/")}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
          title="返回书架"
        >
          <BackIcon />
        </button>
        <h1 className="text-lg font-bold">书源</h1>
        <span className="text-xs text-neutral-500">
          共 {rows.length} 个源 · {totalBooks} 本书
        </span>
        <button
          onClick={() => nav("/sources/new")}
          className="ml-auto flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-amber-400"
        >
          <PlusIcon />
          新建
        </button>
      </header>

      {msg && (
        <div className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 shadow-lg">
          {msg}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="w-40 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
          placeholder="筛选（名称/URL/分组）"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <input
          className="min-w-40 flex-1 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
          placeholder="书源 JSON 地址批量导入"
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
        />
        <button onClick={doImportUrl} disabled={busy} className="rounded-lg bg-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-600 disabled:opacity-50">
          导入
        </button>
        <button onClick={doExport} className="rounded-lg bg-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-600">
          导出
        </button>
      </div>

      <div className="space-y-2">
        {shown.map((r) => (
          <div
            key={r.id}
            onClick={() => nav(`/sources/${r.id}`)}
            className="flex cursor-pointer items-center gap-3 rounded-xl bg-neutral-800 px-3 py-2.5 hover:bg-neutral-700/70"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-neutral-100">{r.name}</span>
                {/* 分组标签：导入的 Legado 源自带 bookSourceGroup（常见「自制」「网络文学」），
                    自建源默认「默认」。以前只在非默认时才显示，看起来像「导入的有、自己写的没有」，现在统一显示 */}
                <span className="flex-none rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300">{r.group || "默认"}</span>
                {r.type === "script" && (
                  <span className="flex-none rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] text-amber-400">脚本</span>
                )}
                {!r.enabled && (
                  <span className="flex-none rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400">停用</span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-500">
                {r.bookCount ? (
                  <span className="text-neutral-400">{r.bookCount} 本书</span>
                ) : (
                  <span>暂无书籍</span>
                )}
                {r.bookUrl && <span className="ml-1 font-mono opacity-70"> · {r.bookUrl}</span>}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                nav(`/sources/${r.id}?tab=debug`);
              }}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-700 hover:text-amber-400"
              title="调试这个源"
            >
              <BugIcon />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                del(r);
              }}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-neutral-500 hover:bg-red-950 hover:text-red-400"
              title="删除书源"
            >
              <TrashIcon />
            </button>
          </div>
        ))}
        {!shown.length && (
          <div className="rounded-xl bg-neutral-800 p-6 text-center text-sm text-neutral-500">
            {rows.length ? "没有匹配的书源" : "还没有书源，点右上角「新建」或粘贴 JSON 地址导入"}
          </div>
        )}
      </div>
    </div>
  );
}
