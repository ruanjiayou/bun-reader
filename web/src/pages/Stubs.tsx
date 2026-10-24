export function Stub({ title, milestone }: { title: string; milestone: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center text-neutral-500">
      {title} · {milestone} 开发
    </div>
  );
}
