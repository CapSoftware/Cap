import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CameraPage } from "./CameraPage";
import "./camera.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing root element");
}

createRoot(container).render(
	<StrictMode>
		<CameraPage />
	</StrictMode>,
);
