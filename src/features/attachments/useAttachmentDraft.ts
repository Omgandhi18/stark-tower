// The files attached to a message being written: picked, pasted or dropped. Each is
// copied into Starkline's attachments folder as it's added; the chips show them.
import { useCallback, useEffect, useRef, useState } from "react";
import { attachData, attachFiles, discardAttachments } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Attachment } from "../../lib/types";
import { pastedName, toBase64 } from "./attachmentFormat";

/** The most files one message carries. */
export const MAX_FILES_PER_MESSAGE = 10;

export type FilesUpdate = (update: (current: readonly Attachment[]) => Attachment[]) => void;

export interface AttachmentDraft {
  files: readonly Attachment[];
  /** Files still being copied in. */
  adding: number;
  error: string | null;
  /** Files the macOS picker or a drop named by path. */
  addPaths: (paths: readonly string[]) => void;
  /** Files pasted or dropped as data (a screenshot, or a drop in a browser preview). */
  addBlobs: (blobs: readonly File[]) => void;
  remove: (file: Attachment) => void;
  /** The message went: the chips go, and the files stay with it. */
  sent: () => void;
}

/** `files` and `update` hold the list: the chat store for a conversation, local state for the Work box. */
export function useAttachmentDraft(files: readonly Attachment[], update: FilesUpdate): AttachmentDraft {
  const [adding, setAdding] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const countRef = useRef(files.length);
  useEffect(() => {
    countRef.current = files.length;
  });

  const room = useCallback((wanted: number) => {
    const left = MAX_FILES_PER_MESSAGE - countRef.current;
    if (wanted > left) setError(`A message can carry up to ${MAX_FILES_PER_MESSAGE} files.`);
    return Math.max(0, Math.min(wanted, left));
  }, []);

  const add = useCallback(
    async (count: number, keep: () => Promise<Attachment[]>) => {
      setError(null);
      setAdding((n) => n + count);
      try {
        const kept = await keep();
        update((current) => [...current, ...kept.filter((k) => !current.some((c) => c.path === k.path))]);
      } catch (e) {
        setError(errorMessage(e, "That file couldn't be attached."));
      } finally {
        setAdding((n) => n - count);
      }
    },
    [update],
  );

  const addPaths = useCallback(
    (paths: readonly string[]) => {
      const take = paths.slice(0, room(paths.length));
      if (take.length) void add(take.length, () => attachFiles([...take]));
    },
    [add, room],
  );

  const addBlobs = useCallback(
    (blobs: readonly File[]) => {
      const take = blobs.slice(0, room(blobs.length));
      if (!take.length) return;
      const now = new Date();
      void add(take.length, () => Promise.all(take.map(async (blob) => attachData(pastedName(blob.name, blob.type, now), await toBase64(blob)))));
    },
    [add, room],
  );

  const remove = useCallback(
    (file: Attachment) => {
      setError(null);
      update((current) => current.filter((c) => c.path !== file.path));
      // Never sent, so nothing else holds it.
      discardAttachments([file]).catch((e) => console.error("[attachments] couldn't remove the copy", e));
    },
    [update],
  );

  const sent = useCallback(() => {
    setError(null);
    update(() => []);
  }, [update]);

  return { files, adding, error, addPaths, addBlobs, remove, sent };
}
