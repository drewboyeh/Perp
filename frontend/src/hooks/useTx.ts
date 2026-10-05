import { useCallback, useState } from "react";
import { errorMessage } from "../lib/format";

export interface Toast {
  id: number;
  kind: "pending" | "success" | "error" | "info";
  text: string;
}

let nextId = 1;

export function useTx(onDone: () => void) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);

  const update = (id: number, t: Partial<Toast>) => setToasts((ts) => ts.map((x) => (x.id === id ? { ...x, ...t } : x)));
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);
  const finish = useCallback(
    (id: number, kind: Toast["kind"], text: string) => {
      update(id, { kind, text });
      setTimeout(() => dismiss(id), kind === "error" ? 9000 : 5000);
    },
    [dismiss],
  );

  /** Runs a wallet action; blocks other actions while the user signs and it confirms. */
  const run = useCallback(
    async (label: string, fn: () => Promise<void>): Promise<boolean> => {
      const id = nextId++;
      setToasts((ts) => [...ts, { id, kind: "pending", text: `${label}…` }]);
      setBusy(true);
      try {
        await fn();
        finish(id, "success", label);
        return true;
      } catch (e) {
        finish(id, "error", `${label} failed: ${errorMessage(e)}`);
        return false;
      } finally {
        setBusy(false);
        onDone();
      }
    },
    [finish, onDone],
  );

  /** Shows a background status (e.g. waiting for a keeper) without blocking the UI. */
  const track = useCallback(
    async (label: string, wait: () => Promise<{ kind: Toast["kind"]; text: string }>) => {
      const id = nextId++;
      setToasts((ts) => [...ts, { id, kind: "pending", text: label }]);
      try {
        const r = await wait();
        finish(id, r.kind, r.text);
      } catch (e) {
        finish(id, "error", errorMessage(e));
      } finally {
        onDone();
      }
    },
    [finish, onDone],
  );

  return { toasts, busy, run, track, dismiss };
}

export type Tx = ReturnType<typeof useTx>;
