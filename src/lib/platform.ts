// Where the UI is running. The browser preview has no Tauri APIs and no
// native window controls.
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

/** macOS draws its own red/yellow/green buttons over the top-left of the window. */
export const HAS_LEFT_WINDOW_CONTROLS = IS_TAURI && IS_MAC;
