import { navigate, type Route } from "./routes";
import { PoPage } from "./product/PoPage";
import { ProductHome } from "./product/ProductHome";

type ProductRoute = Extract<Route, { page: "product" }>;

// The Product section: the Product owners (one per project of the product), the product context, and the memory
// search (product/ProductHome); a Product owner's page shows its documents — context, design, tickets — and journals
// as tabs beside the chat that changes them (product/PoPage). The open PO, tab and ticket are in the route.
export const ProductPage = ({ route, onError }: { route: ProductRoute; onError: (m: string) => void }) => {
    const po = route.po;
    return po
        ? <PoPage key={po} id={po} tab={route.tab} ticket={route.ticket} ticketTab={route.ticketTab} onTab={(t) => navigate({ page: "product", po, tab: t })} onBack={() => navigate({ page: "product" })} onError={onError} />
        : <ProductHome route={route} onOpen={(id) => navigate({ page: "product", po: id })} onError={onError} />;
};
