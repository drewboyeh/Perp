import { useCallback, useState } from "react";
import { errorMessage } from "../lib/format";

export interface Toast {
  id: number;
  kind: "pending" | "success" | "error";
  text: string;
}

let nextId = 1;

export function useTx(onDone: () => void) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);

  const update = (id: number, t: Partial<Toast>) => setToasts((ts) => ts.map((x) => (x.id === id ? { ...x, ...t } : x)));
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>): Promise<boolean> => {
      const id = nextId++;
      setToasts((ts) => [...ts, { id, kind: "pending", text: `${label}…` }]);
      setBusy(true);
      try {
        await fn();
        update(id, { kind: "success", text: label });
        setTimeout(() => dismiss(id), 4000);
        return true;
      } catch (e) {
        update(id, { kind: "error", text: `${label} failed: ${errorMessage(e)}` });
        setTimeout(() => dismiss(id), 9000);
        return false;
      } finally {
        setBusy(false);
        onDone();
      }
    },
    [dismiss, onDone],
  );

  return { toasts, busy, run, dismiss };
}

export type Tx = ReturnType<typeof useTx>;
