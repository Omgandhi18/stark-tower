import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "../../../design";

/** How long "Copied" shows before the button goes back to Copy. */
const COPIED_MS = 1500;

/** Monospace text with a copy button; tall text scrolls inside a fixed height. */
export default function CodeBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch((e) => console.error("[tool-run] copy failed", e));
  };
  return (
    <div className="tool-code">
      <pre className="tool-code-text mono selectable" tabIndex={0} aria-label={label}>
        {text}
      </pre>
      <IconButton className="tool-code-copy" size="sm" icon={copied ? Check : Copy} label={copied ? "Copied" : `Copy ${label.toLowerCase()}`} onClick={copy} />
    </div>
  );
}
