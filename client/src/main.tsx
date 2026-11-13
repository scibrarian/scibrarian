import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "./api";
import { refuseStrayDrops, watchPageDrags } from "./lib/dropped-files";
import { createSources, SourcesContext } from "./lib/sources";
import "./styles.css";

refuseStrayDrops(window);
watchPageDrags(window);

const sources = createSources(api);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SourcesContext.Provider value={sources}>
      <App />
    </SourcesContext.Provider>
  </React.StrictMode>
);
