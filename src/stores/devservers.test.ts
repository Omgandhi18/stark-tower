import { beforeEach, expect, it } from "vitest";
import { useDevServers } from "./devservers";
import type { Server } from "../lib/types";

const server: Server = { folder: "/real/project", command: "npm run dev", status: "starting", address: null, exit_code: null, generation: 1, open_page: true };
beforeEach(() => useDevServers.setState({ servers: {}, output: {}, folders: {}, cleared: {} }));

it("resolves a folder alias and clears only the lines already displayed", () => {
  const store = useDevServers.getState();
  store.rememberFolder("/alias", server.folder);
  store.apply(server);
  store.append({ folder: server.folder, generation: 1, cursor: 2, lines: ["one", "two"] });
  store.clear("/alias");
  expect(useDevServers.getState().cleared[server.folder]).toEqual({ generation: 1, cursor: 2 });
  store.append({ folder: server.folder, generation: 1, cursor: 3, lines: ["three"] });
  expect(useDevServers.getState().output[server.folder].lines).toEqual(["one", "two", "three"]);
});

it("resets output on restart and ignores output and starting states from an older run", () => {
  const store = useDevServers.getState();
  store.apply(server);
  store.append({ folder: server.folder, generation: 1, cursor: 1, lines: ["old"] });
  store.apply({ ...server, generation: 2 });
  store.append({ folder: server.folder, generation: 1, cursor: 2, lines: ["late"] });
  store.apply(server);
  expect(useDevServers.getState().output[server.folder].lines).toEqual([]);
  expect(useDevServers.getState().servers[server.folder].generation).toBe(2);
  store.apply({ ...server, generation: 2, status: "running", address: "http://localhost:5173/" });
  store.apply({ ...server, generation: 2 });
  expect(useDevServers.getState().servers[server.folder].status).toBe("running");
});
