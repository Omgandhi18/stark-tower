// Full screen for the native window in Tauri, or the element in a browser preview.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_TAURI } from "./platform";

export async function toggleFullscreen(element: HTMLElement): Promise<void> {
  if (IS_TAURI) {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
    return;
  }
  if (document.fullscreenElement) await document.exitFullscreen();
  else await element.requestFullscreen();
}
