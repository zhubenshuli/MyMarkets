import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import MarketsPage from "./Page.tsx";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <MarketsPage />
    </StrictMode>,
  );
}
