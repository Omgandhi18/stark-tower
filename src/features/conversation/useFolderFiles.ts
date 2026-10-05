import { useCallback, useState } from "react";
import type { PathEntry } from "../../lib/types";
import type { ScanStatus } from "./fileMentions";
import { scanFolder } from "./fileIndex";

interface Listing {
  folder: string;
  entries: PathEntry[];
  status: ScanStatus;
}

/** The files in a chat's folder, scanned the first time they're asked for. */
export function useFolderFiles(folder: string) {
  const [listing, setListing] = useState<Listing>({ folder: "", entries: [], status: "idle" });

  const request = useCallback(() => {
    if (!folder) return;
    setListing((l) => (l.folder === folder && l.status !== "idle" ? l : { folder, entries: [], status: "loading" }));
    scanFolder(folder)
      .then((entries) => setListing((l) => (l.folder === folder ? { folder, entries, status: "ready" } : l)))
      .catch(() => setListing((l) => (l.folder === folder ? { folder, entries: [], status: "error" } : l)));
  }, [folder]);

  const current = listing.folder === folder ? listing : { folder, entries: [], status: "idle" as const };
  return { ...current, request };
}
