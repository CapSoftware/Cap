import React from "react";
import App from "./App";
import { createRoot } from "react-dom/client";

const container = document.createElement("div");
container.id = "cap-loom-importer";
container.style.position = "fixed";
container.style.bottom = "200px";
container.style.right = "200px";
container.style.zIndex = "9999";
document.body.appendChild(container);

const styleLink = document.createElement("link");
styleLink.type = "text/css";
styleLink.rel = "stylesheet";
styleLink.href = chrome.runtime.getURL("/react/main.css");
document.head.appendChild(styleLink);

const root = createRoot(container);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
