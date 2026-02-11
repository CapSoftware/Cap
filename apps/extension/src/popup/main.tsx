import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing root element");
}

createRoot(container).render(
	<>
		<App />
		<Toaster richColors />
	</>,
);
