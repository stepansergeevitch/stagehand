// localStorage wrapped so a browser that refuses it (Safari private mode, storage disabled, quota) degrades to
// "not remembered" instead of throwing inside a React render and blanking the whole page.
export const storage = {
    get(key: string): string | null {
        try {
            return localStorage.getItem(key);
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
