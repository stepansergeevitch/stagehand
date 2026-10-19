import { Tabs } from "@vortex/ds";

// List | Feed, beside the Tasks title on both views (the route decides which is open).
export const ViewSwitch = ({ view, onChange }: { view: "list" | "feed"; onChange: (v: "list" | "feed") => void }) => (
    <Tabs
        className="view-switch"
        variant="pill"
        items={[{ key: "list", label: "List" }, { key: "feed", label: "Feed" }]}
        active={view}
        onChange={(k) => onChange(k === "feed" ? "feed" : "list")}
    />
);
