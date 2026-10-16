import { Skeleton } from "@vortex/ds";
import "./loading.css";

// The placeholder of a tab or page that is still reading its data.
export const Loading = ({ lines = 4 }: { lines?: number }) => (
    <div className="loading" role="status" aria-label="Loading">
        {Array.from({ length: lines }, (_, i) => <Skeleton key={i} height={i === 0 ? 32 : 56} />)}
    </div>
);
