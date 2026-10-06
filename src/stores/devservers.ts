import { create } from "zustand";
import type { Output, Server } from "../lib/types";
import { mergeOutput } from "../features/preview/browserModel";

interface DevServersState {
  folders: Record<string, string>;
  rememberFolder: (requested: string, resolved: string) => void;
  cleared: Record<string, { generation: number; cursor: number }>;
  clear: (folder: string) => void;
  servers: Record<string, Server>;
  output: Record<string, Output>;
  apply: (server: Server) => void;
  append: (output: Output) => void;
}

export const useDevServers = create<DevServersState>((set) => ({
  folders: {},
  rememberFolder: (requested, resolved) => set((s) => ({ folders: { ...s.folders, [requested]: resolved } })),
  cleared: {},
  clear: (folder) =>
    set((s) => {
      const output = s.output[s.folders[folder] ?? folder];
      return output ? { cleared: { ...s.cleared, [output.folder]: { generation: output.generation, cursor: output.cursor } } } : {};
    }),
  servers: {},
  output: {},
  apply: (server) =>
    set((s) => {
      const previous = s.servers[server.folder];
      if (
        previous &&
        (previous.generation > server.generation ||
          (previous.generation === server.generation && previous.status !== "starting" && server.status === "starting"))
      )
        return {};
      const newRun = !previous || server.generation > previous.generation;
      return {
        servers: { ...s.servers, [server.folder]: server },
        output: newRun
          ? {
              ...s.output,
              [server.folder]: mergeOutput(s.output[server.folder], { folder: server.folder, generation: server.generation, cursor: 0, lines: [] }),
            }
          : s.output,
      };
    }),
  append: (output) => set((s) => ({ output: { ...s.output, [output.folder]: mergeOutput(s.output[output.folder], output) } })),
}));
