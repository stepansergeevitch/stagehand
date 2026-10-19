import type { FeedEvent } from "./api";

// Feed events pushed over the socket (kind "feed"): the Feed page subscribes while it is open.
const listeners = new Set<(ev: FeedEvent) => void>();

export const feedBus = {
    emit: (ev: FeedEvent): void => {
        for (const fn of listeners) fn(ev);
    },
    subscribe: (fn: (ev: FeedEvent) => void): (() => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
};
