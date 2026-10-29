import { useRef, useState, type ReactNode } from "react";

export interface ConfirmOpts {
  title: string;
  desc?: ReactNode; // 说明影响范围（删了什么、能不能恢复）
  okText?: string;
  cancelText?: string;
  danger?: boolean; // 默认红色确认键（删除类）；传 false 走琥珀色（普通动作）
}

// 危险操作统一确认：`const [ask, confirmUi] = useConfirm()` → `await ask({...})` 得 boolean，
// 页面里把 confirmUi 放到最外层渲染即可。
// 不用 window.confirm：iOS PWA / 内嵌 WebView 里样式不可控，个别浏览器还会静默吞掉，
// 「点了没反应就直接删了」是最不能接受的失败方式。
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);
  const ask = (o: ConfirmOpts) =>
    new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setOpts(o);
    });
  const close = (v: boolean) => {
    resolveRef.current?.(v);
    resolveRef.current = null;
    setOpts(null);
  };
  const ui = opts ? (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6" onClick={() => close(false)}>
      <div className="w-full max-w-sm rounded-2xl bg-neutral-800 p-5 shadow-2xl ring-1 ring-neutral-700" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-neutral-100">{opts.title}</h3>
        {opts.desc && <p className="mt-2 whitespace-pre-line text-sm leading-6 text-neutral-400">{opts.desc}</p>}
        <div className="mt-5 flex gap-2">
          <button
            onClick={() => close(false)}
            className="flex-1 rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-600"
          >
            {opts.cancelText ?? "取消"}
          </button>
          <button
            onClick={() => close(true)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium ${
              opts.danger === false
                ? "bg-amber-500 text-neutral-900 hover:bg-amber-400"
                : "bg-red-600 text-white hover:bg-red-500"
            }`}
          >
            {opts.okText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return [ask, ui] as const;
}
