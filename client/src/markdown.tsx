import Markdown from "markdown-to-jsx/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

// The body of a memo, written in Markdown by people and by AI over MCP. Raw HTML is shown as text, never parsed, and
// unsafe URLs are dropped by the library's sanitizer. Images are not loaded (the page allows no outside images);
// they become links. Links open in a new tab.
function ExternalLink({ href, children, title }: { href?: string; children?: ReactNode; title?: string }) {
  if (href === undefined || href === "") return <>{children}</>;
  return (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

function ImageAsLink({ src, alt }: { src?: string; alt?: string }) {
  if (src === undefined || src === "") return <>{alt}</>;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer nofollow">
      画像: {alt === undefined || alt === "" ? src : alt}
    </a>
  );
}

// A table that scrolls sideways inside its own box, with a note when it is wider than the box.
function ScrollTable({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const check = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="table-block">
      <div ref={ref} className={overflow ? "table-scroll table-scroll-more" : "table-scroll"} tabIndex={overflow ? 0 : -1}>
        <table>{children}</table>
      </div>
      {overflow && <p className="table-hint">表は横にスクロールできます</p>}
    </div>
  );
}

const OPTIONS = {
  disableParsingRawHTML: true,
  tagfilter: true,
  forceBlock: true,
  overrides: {
    a: { component: ExternalLink },
    img: { component: ImageAsLink },
    table: { component: ScrollTable },
  },
};

export function MarkdownBody({ source }: { source: string }) {
  return (
    <div className="prose">
      <Markdown options={OPTIONS}>{source}</Markdown>
    </div>
  );
}

// The text of Markdown without its marks, for the previews in lists.
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~|\*|_)(\S[\s\S]*?\S|\S)\1/g, "$2")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The first paragraph of Markdown as plain text, for the excerpts in lists. Headings, tables, rules and code blocks
// are skipped so that the excerpt reads as a sentence.
export function excerptText(markdown: string): string {
  const withoutCode = markdown.replace(/```[\s\S]*?(```|$)/g, "\n\n");
  const blocks = withoutCode.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== "");
  const prose = blocks.filter((block) => {
    const first = block.split("\n")[0] ?? "";
    if (/^#{1,6}\s/.test(first)) return false;
    if (/^\s*\|/.test(first)) return false;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(first)) return false;
    return true;
  });
  // The first paragraph only; a list or a quote after it would read as a run-on sentence.
  return plainText((prose[0] ?? blocks[0] ?? ""));
}
