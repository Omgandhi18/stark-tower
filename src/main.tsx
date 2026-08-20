import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { assertTokensInSync } from "./lib/tokens";

if (import.meta.env.DEV) assertTokensInSync();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
