import { useEffect, useState } from "react";

// xterm (and its fit addon) is loaded only when a terminal is actually shown: it is heavy and it is the one dependency
// with browser-specific requirements, so a phone that never opens a terminal never pays for it or trips over it.
export const LazyTerminal = ({ session }: { session: string }) => {
    const [T, setT] = useState<null | (typeof import("./Terminal"))["Terminal"]>(null);
    useEffect(() => {
        void import("./Terminal").then((m) => setT(() => m.Terminal));
    }, []);
    return T ? <T session={session} /> : <div className="term" />;
};
