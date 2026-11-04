import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { refuseStrayDrops } from "./lib/dropped-files";
import "./styles.css";

refuseStrayDrops(window);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
