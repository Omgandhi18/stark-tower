// The models an installed provider offers, shared by the agent editor and the composer.
import { useEffect, useState } from "react";
import { providerModels } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { ModelChoice } from "../../lib/types";

export interface ModelList {
  engine: string;
  models: ModelChoice[] | null;
  error: string | null;
}

/** The last list each provider gave, so a picker opened again shows it straight away. */
const lastLists = new Map<string, ModelList>();

/** The models an installed provider offers, as it lists them; asked again when the provider changes. */
export function useProviderModels(engineId: string | undefined, installed: boolean): ModelList | null {
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    if (!engineId || !installed) return;
    let live = true;
    providerModels(engineId).then(
      (models) => {
        const next = { engine: engineId, models, error: null };
        lastLists.set(engineId, next);
        if (live) setList(next);
      },
      (e) => live && setList({ engine: engineId, models: null, error: errorMessage(e, "The provider didn't list its models.") }),
    );
    return () => {
      live = false;
    };
  }, [engineId, installed]);
  if (!engineId || !installed) return null;
  return list?.engine === engineId ? list : (lastLists.get(engineId) ?? null);
}
