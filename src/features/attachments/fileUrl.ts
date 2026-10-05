import { convertFileSrc } from "@tauri-apps/api/core";
import { IS_TAURI } from "../../lib/platform";

/** A kept file as a URL the page can show (Tauri's asset protocol); a browser preview gets the path. */
export const fileUrl = (path: string) => (IS_TAURI ? convertFileSrc(path) : path);
