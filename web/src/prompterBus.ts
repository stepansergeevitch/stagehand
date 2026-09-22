import type { PrompterMessage } from "./api";

// Prompter events arrive on the app's one websocket (App.tsx) and are handed to the widget through this bus, so the
// widget needs no socket of its own. `reconnected` fires when the socket came back after a drop (a server restart):
// the widget re-reads its session then.
export type PrompterEvent =
    | { sessionId: string; kind: "text"; text: string }
    | { sessionId: string; kind: "activity"; text: string }
    | { sessionId: string; kind: "done"; message: PrompterMessage | null; error: string | null }
    | { sessionId: string; kind: "queued"; message: PrompterMessage }
    | { sessionId: string; kind: "removed"; messageId: string }
    | { sessionId: string; kind: "turn"; messageIds: string[] }
    // The chat list changed (a chat was created or named): the widget re-reads it.
    | { sessionId: string; kind: "updated" }
    | { sessionId: string; kind: "closed" };

const listeners = new Set<(ev: PrompterEvent) => void>();
const reconnectListeners = new Set<() => void>();

export const prompterBus = {
    emit: (ev: PrompterEvent): void => {
        for (const fn of listeners) fn(ev);
    },
    subscribe: (fn: (ev: PrompterEvent) => void): (() => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
    reconnected: (): void => {
        for (const fn of reconnectListeners) fn();
    },
    onReconnect: (fn: () => void): (() => void) => {
        reconnectListeners.add(fn);
        return () => reconnectListeners.delete(fn);
    },
};
