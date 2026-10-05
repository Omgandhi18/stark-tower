// The Notification Centre's record, mirrored from the backend: everything that
// needed the developer, or may interest them.
import { create } from "zustand";
import { listNotifications, markAllNotificationsRead, markNotificationsRead } from "../lib/api";
import type { Notification } from "../lib/types";

interface NotificationsState {
  items: Notification[];
  loaded: boolean;
  refresh: () => Promise<void>;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: () => Promise<void>;
}

export const useNotifications = create<NotificationsState>((set, get) => ({
  items: [],
  loaded: false,
  refresh: async () => set({ items: await listNotifications(), loaded: true }),
  markRead: async (ids) => {
    const unread = ids.filter((id) => get().items.some((n) => n.id === id && !n.read));
    if (!unread.length) return;
    set((s) => ({ items: s.items.map((n) => (unread.includes(n.id) ? { ...n, read: true } : n)) }));
    await markNotificationsRead(unread);
  },
  markAllRead: async () => {
    set((s) => ({ items: s.items.map((n) => ({ ...n, read: true })) }));
    await markAllNotificationsRead();
  },
}));

/** Still waiting on the developer. */
export const needsYou = (n: Notification) => n.urgency === "needs_you" && n.handled === null;

export const selectNeedsYouCount = (s: NotificationsState) => s.items.filter(needsYou).length;
