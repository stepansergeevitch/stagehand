// Shared number and time formatters. Money and counts group thousands ($68,779); durations and sizes pick a unit.

const grouped = (n: number, digits: number): string => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const money = (n: number): string => (n === 0 ? "$0" : n >= 100 ? `$${grouped(n, 0)}` : n >= 1 ? `$${grouped(n, 2)}` : `$${grouped(n, 3)}`);
export const tokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const hours = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
export const count = (n: number): string => grouped(n, 0);
export const bytes = (n: number | null): string => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
export const megabytes = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
export const when = (iso: string): string => new Date(iso).toLocaleString();
export const errText = (e: unknown): string => String((e as Error).message ?? e);
export const splitCsv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
