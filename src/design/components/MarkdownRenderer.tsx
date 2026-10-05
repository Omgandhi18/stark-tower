import { useRef, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { cx } from "../cx";
import { IconButton } from "./Button";

const EXTERNAL_LINK = /^(https?:|mailto:)/i;
const COPIED_MS = 1600;

/** Links open in the default browser; the app window never navigates away. */
function Link({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const external = Boolean(href && EXTERNAL_LINK.test(href));
  return (
    <a
      {...rest}
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (external && href) openUrl(href).catch((err) => console.error("[markdown] couldn't open link", err));
      }}
    >
      {children}
    </a>
  );
}

function CodeBlock({ children, node: _node, ...rest }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(preRef.current?.innerText ?? "")
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch((err) => console.error("[markdown] couldn't copy", err));
  };
  return (
    <div className="md-code">
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
      <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy code"} size="sm" className="md-copy" onClick={copy} />
    </div>
  );
}

const COMPONENTS: Components = { a: Link, pre: CodeBlock };
const REMARK: Options["remarkPlugins"] = [remarkGfm, remarkBreaks];
const REHYPE: Options["rehypePlugins"] = [[rehypeHighlight, { detect: true, ignoreMissing: true }]];

interface MarkdownRendererProps {
  text: string;
  className?: string;
}

/** Agent-written markdown: GitHub flavour, highlighted code, safe links. */
export default function MarkdownRenderer({ text, className }: MarkdownRendererProps) {
  return (
    <div className={cx("markdown selectable", className)}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
