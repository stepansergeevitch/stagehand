import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

export const Markdown = ({ source }: { source: string }) => {
    const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false }) as string), [source]);
    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
};
