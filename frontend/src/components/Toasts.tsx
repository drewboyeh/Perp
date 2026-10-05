import type { Toast } from "../hooks/useTx";

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon">{t.kind === "pending" ? <span className="spinner" /> : t.kind === "success" ? "✓" : "!"}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
