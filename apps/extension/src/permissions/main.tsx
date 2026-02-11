import { createRoot } from "react-dom/client";
import { PermissionsPage } from "./PermissionsPage";
import "../popup/styles.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing root element");
}

createRoot(container).render(<PermissionsPage />);
