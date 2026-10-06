/**
 * A bundled file's full address, for Pixi's loader. Pixi only treats http(s) pages as URLs,
 * so in the built app, served from tauri://localhost, it turns "/assets/x.png" into
 * "tauri://assets/x.png" and the room can't load. A full address passes through unchanged.
 */
export function fullUrl(url: string, base: string = document.baseURI): string {
  return new URL(url, base).href;
}
