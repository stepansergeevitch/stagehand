import type { PoEvent } from "./api";

// Product Owner events arrive on the app's one websocket (App.tsx) and reach the open PO page through this bus.
const listeners = new Set<(ev: PoEvent) => void>();

export const poBus = {
    emit: (ev: PoEvent): void => {
        for (const fn of listeners) fn(ev);
    },
    subscribe: (fn: (ev: PoEvent) => void): (() => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
};
