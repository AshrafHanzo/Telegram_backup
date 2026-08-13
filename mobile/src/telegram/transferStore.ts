import { create } from "zustand";

export type TransferKind = "upload" | "download";
export type TransferStatus = "active" | "completed" | "failed";

export interface Transfer {
  id: string;
  kind: TransferKind;
  name: string;
  totalBytes: number;
  transferredBytes: number;
  status: TransferStatus;
  speedBps: number;
  error?: string;
  // Used to compute a rolling speed from the last couple of progress ticks,
  // rather than an average-since-start figure that reacts slowly to an
  // actual change in network conditions.
  lastTickAt: number;
  lastTickBytes: number;
}

interface TransferState {
  transfers: Transfer[];
  start: (id: string, kind: TransferKind, name: string, totalBytes: number) => void;
  progress: (id: string, transferredBytes: number, totalBytes?: number) => void;
  complete: (id: string) => void;
  fail: (id: string, error: string) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

// No Date.now() at module scope (that's fine, this only ever runs inside
// action calls, which happens at real interaction time, not script load).
export const useTransferStore = create<TransferState>((set, get) => ({
  transfers: [],

  start: (id, kind, name, totalBytes) => {
    const now = Date.now();
    set((state) => ({
      transfers: [
        ...state.transfers.filter((t) => t.id !== id),
        {
          id,
          kind,
          name,
          totalBytes,
          transferredBytes: 0,
          status: "active",
          speedBps: 0,
          lastTickAt: now,
          lastTickBytes: 0,
        },
      ],
    }));
  },

  progress: (id, transferredBytes, totalBytes) => {
    const now = Date.now();
    set((state) => ({
      transfers: state.transfers.map((t) => {
        if (t.id !== id) return t;
        const elapsedMs = now - t.lastTickAt;
        // Only recompute speed every ~500ms — updateFile can fire in rapid
        // bursts, and recomputing on every single event makes the number
        // jitter too much to read.
        if (elapsedMs < 500) {
          return { ...t, transferredBytes, totalBytes: totalBytes ?? t.totalBytes };
        }
        const deltaBytes = transferredBytes - t.lastTickBytes;
        const speedBps = deltaBytes > 0 ? (deltaBytes / elapsedMs) * 1000 : t.speedBps;
        return {
          ...t,
          transferredBytes,
          totalBytes: totalBytes ?? t.totalBytes,
          speedBps,
          lastTickAt: now,
          lastTickBytes: transferredBytes,
        };
      }),
    }));
  },

  complete: (id) => {
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, status: "completed" as const, speedBps: 0 } : t,
      ),
    }));
  },

  fail: (id, error) => {
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, status: "failed" as const, error, speedBps: 0 } : t,
      ),
    }));
  },

  dismiss: (id) => {
    set((state) => ({ transfers: state.transfers.filter((t) => t.id !== id) }));
  },

  clearFinished: () => {
    set((state) => ({ transfers: state.transfers.filter((t) => t.status === "active") }));
  },
}));

export function activeTransferCount(): number {
  return useTransferStore.getState().transfers.filter((t) => t.status === "active").length;
}
