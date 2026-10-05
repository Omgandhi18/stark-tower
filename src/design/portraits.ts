// Portraits are keyed by appearance (`figure`), never by the agent's name:
// names are the user's to choose.
const PORTRAITS = import.meta.glob<string>("../assets/portraits/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

export function portraitUrl(figure: string | null | undefined): string | undefined {
  if (!figure) return undefined;
  return Object.entries(PORTRAITS).find(([path]) => path.endsWith(`/${figure}.png`))?.[1];
}
