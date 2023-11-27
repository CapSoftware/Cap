import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import { Editor } from "@/components/windows/Editor";
import { Camera } from "@/components/windows/Camera";
import { Options } from "@/components/windows/Options";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    Component: Editor,
  },
  {
    path: "/camera",
    Component: Camera,
  },
  {
    path: "/options",
    Component: Options,
  },
]);

const container = document.getElementById("root");

if (!container) {
  throw new Error("root container not found");
}

const root = createRoot(container);

root.render(
  <React.StrictMode>
    <App>
      <RouterProvider router={router} />
    </App>
  </React.StrictMode>
);
