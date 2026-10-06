import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { browserNavigate, terminalAttach, terminalResize, terminalWrite, terminalTitle } from "../../lib/api";
import type { TerminalOutput } from "../../lib/bindings";
import { useNavigation } from "../../stores/navigation";
import { usePreview } from "../../stores/preview";
import { useTerminal } from "../../stores/terminal";
import { localTerminalLink, unseenOutput } from "./terminalModel";

const runtimes = new Map<string, { terminal: Terminal; fit: FitAddon; element: HTMLDivElement; observer: MutationObserver }>();
const fail = () => useTerminal.getState().report("The terminal couldn't connect. Close this tab and open a new terminal to try again.");

/** A local page opens in the browser beside the chat; anything else (or from a task page) in the default browser. */
function openLink(uri: string) {
  const report = (message: string) => () => useTerminal.getState().report(message);
  if (localTerminalLink(uri) && useNavigation.getState().route === "conversation") {
    usePreview.getState().show("browser");
    void browserNavigate(uri).catch(report("Couldn't open this page. Try the address in the browser panel."));
  } else {
    void openUrl(uri).catch(report("Couldn't open this link. Copy it into your browser."));
  }
}

export function terminalTheme(terminal: Terminal) {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  terminal.options.theme = { background: token("--surface-sunken"), foreground: token("--text"), cursor: token("--accent"), selectionBackground: token("--accent-ring") };
  terminal.options.fontFamily = token("--font-mono");
  terminal.options.fontSize = Number.parseFloat(token("--text-sm")) || 13;
}

export function getTerminalRuntime(id: string) {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const element = document.createElement("div");
  element.className = "terminal-emulator";
  const terminal = new Terminal({ screenReaderMode: true, fontSize: 13, scrollback: 10000 });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
  terminalTheme(terminal);
  terminal.open(element);
  const observer = new MutationObserver(() => {
    terminalTheme(terminal);
    if (element.isConnected && element.getBoundingClientRect().width && element.getBoundingClientRect().height) fit.fit();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  const runtime = { terminal, fit, element, observer };
  runtimes.set(id, runtime);
  terminal.onData((data) => { void terminalWrite(id, data).catch(fail); });
  terminal.onResize(({ cols, rows }) => { void terminalResize(id, cols, rows).catch(fail); });
  terminal.onTitleChange((title) => { useTerminal.getState().update(id, { title }); void terminalTitle(id, title).catch(fail); });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.ctrlKey && !event.metaKey && event.code === "Backquote") return false;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey) return false;
    if (!event.metaKey) return true;
    const key = event.key.toLowerCase();
    if (!["c", "v", "k"].includes(key)) return true;
    if (key === "c" && !terminal.hasSelection()) return true;
    if (event.type === "keydown") {
      event.preventDefault();
      if (key === "c") void navigator.clipboard.writeText(terminal.getSelection()).catch(fail);
      if (key === "v") void navigator.clipboard.readText().then((text) => terminal.paste(text)).catch(fail);
      if (key === "k") terminal.clear();
    }
    return false;
  });
  let offset = 0;
  let ready = false;
  const pending: TerminalOutput[] = [];
  const apply = (output: TerminalOutput) => {
    const bytes = unseenOutput(output, offset);
    if (bytes.length) { terminal.write(bytes); offset = output.offset; }
    if (output.exit_code !== null) useTerminal.getState().update(id, { alive: false, exit_code: output.exit_code });
  };
  const channel = new Channel<TerminalOutput>((output) => { if (ready) apply(output); else pending.push(output); });
  void terminalAttach(id, channel).then((snapshot) => {
    terminal.write(new Uint8Array(snapshot.data));
    offset = snapshot.offset;
    if (snapshot.exit_code !== null) useTerminal.getState().update(id, { alive: false, exit_code: snapshot.exit_code });
    ready = true;
    pending.forEach(apply);
    pending.length = 0;
  }).catch(fail);
  return runtime;
}

export function disposeTerminal(id: string) {
  const runtime = runtimes.get(id);
  if (!runtime) return;
  runtime.observer.disconnect();
  runtime.terminal.dispose();
  runtimes.delete(id);
}
