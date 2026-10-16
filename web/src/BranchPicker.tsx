import { useEffect, useId, useState } from "react";
import { api } from "./api";
import { Input } from "@vortex/ds";

// Remote branches of one repository of an env, fetched once per (env, repo) and kept for the page's life.
const cache = new Map<string, Promise<string[]>>();
const branchesOf = (envId: string, repo: string): Promise<string[]> => {
    const key = `${envId}:${repo}`;
    let p = cache.get(key);
    if (!p) {
        p = api.branches(envId, repo).then((r) => r.branches);
        p.catch(() => cache.delete(key));
        cache.set(key, p);
    }
    return p;
};

// A branch name input with a searchable dropdown of the repository's remote branches (native datalist: typing filters
// by substring, the arrow key opens the full list). Free text is still accepted — a branch that exists only locally.
export const BranchPicker = ({ envId, repo = "", value, onChange, placeholder, autoFocus = false, style }: {
    envId: string;
    repo?: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    autoFocus?: boolean;
    style?: React.CSSProperties;
}) => {
    const id = useId();
    const [names, setNames] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        setNames(null);
        setError(null);
        branchesOf(envId, repo).then((n) => alive && setNames(n)).catch((e: Error) => alive && setError(e.message));
        return () => { alive = false; };
    }, [envId, repo]);
    return (
        <span className="branch-picker">
            <Input list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} autoComplete="off" style={style} />
            <datalist id={id}>{(names ?? []).map((n) => <option key={n} value={n} />)}</datalist>
            <span className="field-hint branch-picker-hint">{error ? `branches unavailable: ${error}` : names === null ? "loading branches…" : `${names.length} remote branch${names.length === 1 ? "" : "es"}`}</span>
        </span>
    );
};
