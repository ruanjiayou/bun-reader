// 统一 API 封装：带 cookie、非 2xx 抛错
// API 前缀：默认 /gw/reader（网关路径）。dev 由 vite 代理转发到 http://192.168.1.124/gw/reader（路径原样保留）；
// 可用 VITE_API_BASE 覆盖（如置空串则直连同源 /api，本地直连后端调试用）
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/gw/reader";

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `请求失败 ${res.status}`);
  return data as T;
}

// 书籍状态枚举（与后端 BookStatus 保持一致）；0 是唯一还会更新的状态，巡检只跑它
export const BOOK_STATUS = [
  { value: 0, label: "连载中" },
  { value: 1, label: "已完结" },
  { value: 2, label: "太监/断更" },
  { value: 3, label: "已下架" },
];
export const statusLabel = (s?: number) => BOOK_STATUS.find((x) => x.value === s)?.label ?? "未知状态";
// 角标配色写死类名（Tailwind 不编译动态拼接的类）；以后新增枚举值同步这里即可
export const statusBadgeClass = (s?: number) =>
  s === 1 ? "bg-green-700 text-green-100" : s === 2 ? "bg-orange-700 text-orange-100" : s === 3 ? "bg-red-800 text-red-100" : "bg-neutral-700 text-neutral-100";

// 最新章节展示：详情抓到标题显示标题；库里只有链接（历史数据/标题取不到）时兜底显示页码
export const fmtLatest = (s: string) => {
  if (/^(https?:)?\/\//i.test(s) || s.startsWith("/")) {
    const m = s.match(/(\d+)(?:\.html?)?\/?$/i);
    if (m) return `第 ${m[1]} 页`;
  }
  return s;
};
