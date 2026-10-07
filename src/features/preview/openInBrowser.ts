// Pages agents make open in the built-in browser beside the chat, not in another app.
import { openPath } from "@tauri-apps/plugin-opener";
import { attachmentUrl, browserNavigate } from "../../lib/api";
import { useNavigation } from "../../stores/navigation";
import { usePreview } from "../../stores/preview";

/**
 * Open a kept file (a page an agent made) in the built-in browser, which lives in a task's
 * side panel: this one's, else the task last open. With no task to show it beside, it opens
 * in your default browser instead.
 */
export async function openInBuiltInBrowser(path: string): Promise<void> {
  const navigation = useNavigation.getState();
  if (navigation.route !== "task") {
    if (!navigation.taskId) {
      await openPath(path);
      return;
    }
    navigation.openTask(navigation.taskId);
  }
  const url = await attachmentUrl(path);
  usePreview.getState().show("browser");
  await browserNavigate(url);
}
