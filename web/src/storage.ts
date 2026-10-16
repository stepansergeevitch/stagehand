// localStorage wrapped so a browser that refuses it (Safari private mode, storage disabled, quota) degrades to
// "not remembered" instead of throwing inside a React render and blanking the whole page.
// Keys written before the rename (stagehand.*) are read once and copied to their vortex.* name.
const LEGACY_PREFIX = "stagehand.";
export const storage = {
    get(key: string): string | null {
        try {
            const v = localStorage.getItem(key);
            if (v !== null || !key.startsWith("vortex.")) return v;
            const old = localStorage.getItem(LEGACY_PREFIX + key.slice("vortex.".length));
            if (old !== null) localStorage.setItem(key, old);
            return old;
        } catch {
            return null;
        }
    },
    set(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch {
            /* not remembered */
        }
    },
    remove(key: string): void {
        try {
            localStorage.removeItem(key);
        } catch {
            /* nothing to forget */
        }
    },
};
