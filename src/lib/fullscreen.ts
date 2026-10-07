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

/** Put the native window (in a browser preview, the element) into full screen, or take it out. */
export async function setFullscreen(element: HTMLElement, on: boolean): Promise<void> {
  if (IS_TAURI) {
    await getCurrentWindow().setFullscreen(on);
    return;
  }
  if (on && !document.fullscreenElement) await element.requestFullscreen();
  else if (!on && document.fullscreenElement) await document.exitFullscreen();
}
