import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { applyTheme, storedTheme } from "./app/theme";
import "./design/tokens.css";
import "./design/base.css";
import "./design/components.css";
import "./design/markdown.css";

// Wear last session's theme from the first paint; the saved config confirms it once loaded.
applyTheme(storedTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
