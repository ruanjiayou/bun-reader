import { useState } from "react";
import { api } from "../api";

export default function Auth({ onOk }: { onOk: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api(`/auth/${mode}`, { method: "POST", body: JSON.stringify({ username, password }) });
      onOk();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-neutral-800 p-6">
        <h1 className="text-center text-xl font-bold">阅读</h1>
        <input
          className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-base outline-none focus:ring-2 focus:ring-amber-500"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-base outline-none focus:ring-2 focus:ring-amber-500"
          placeholder="密码（≥6位）"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && <p className="text-sm text-red-400">{err}</p>}
        <button
          disabled={busy}
          className="w-full rounded-lg bg-amber-500 py-2 font-medium text-neutral-900 disabled:opacity-50"
        >
          {mode === "login" ? "登录" : "注册"}
        </button>
        <button
          type="button"
          className="w-full text-center text-sm text-neutral-400 hover:text-neutral-200"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
        </button>
      </form>
    </div>
  );
}
