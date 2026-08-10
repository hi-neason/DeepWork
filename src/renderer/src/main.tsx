import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import i18n from "./i18n";
import "./styles.css";

function MissingPreload(): React.ReactElement {
  return (
    <main className="preload-missing">
      <section className="preload-missing-card">
        <h1>{i18n.t("errors.preloadMissing.title")}</h1>
        <p>{i18n.t("errors.preloadMissing.body")}</p>
        <code>{i18n.t("errors.preloadMissing.command")}</code>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.deepwork ? <App /> : <MissingPreload />}
  </React.StrictMode>,
);
