import { Component, type ErrorInfo, type ReactNode } from "react";

// A render error inside one view must not blank the whole app (React unmounts the tree on an uncaught render error —
// on a phone that was "a blank screen with no way to tell why"). Shows the message and a way back instead.
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
    override state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error): { error: Error } {
        return { error };
    }
    override componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("[stagehand] render error", error, info.componentStack);
    }
    override render(): ReactNode {
        if (!this.state.error) return this.props.children;
        return (
            <div className="blocked-box render-error">
                <b>{this.props.label ?? "This view"} crashed.</b> {this.state.error.message}
                <pre>{this.state.error.stack?.split("\n").slice(0, 6).join("\n")}</pre>
                <div className="actions" style={{ marginBottom: 0 }}>
                    <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
                    <button onClick={() => { location.hash = "#/dashboard"; location.reload(); }}>Reload to the dashboard</button>
                </div>
            </div>
        );
    }
}
