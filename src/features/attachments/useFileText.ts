import { useEffect, useState } from "react";
import { readAttachmentText } from "../../lib/api";
import { errorMessage } from "../../lib/errors";

/** The start of a kept text, Markdown or HTML file. */
export function useFileText(path: string) {
  const [state, setState] = useState<{ path: string; text: string | null; error: string | null }>({ path, text: null, error: null });
  useEffect(() => {
    let current = true;
    readAttachmentText(path)
      .then((text) => current && setState({ path, text, error: null }))
      .catch((e) => current && setState({ path, text: null, error: errorMessage(e, "The file couldn't be read.") }));
    return () => {
      current = false;
    };
  }, [path]);
  return state.path === path ? state : { path, text: null, error: null };
}
