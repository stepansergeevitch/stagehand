import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export const Terminal = ({ session }: { session: string }) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const term = new XTerm({ fontFamily: '"IBM Plex Mono", Menlo, monospace', fontSize: 12.5, theme: { background: "#0b1116" }, cursorBlink: true });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(el);
        fit.fit();

        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(session)}`);
        ws.onopen = () => ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
        ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
        ws.onclose = () => term.write("\r\n[stagehand] terminal closed\r\n");
        const onData = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "i", d })));
        const onResize = () => {
            fit.fit();
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(el);
        term.focus();

        return () => {
            ro.disconnect();
            onData.dispose();
            ws.close();
            term.dispose();
        };
    }, [session]);

    return <div className="term" ref={ref} />;
};
