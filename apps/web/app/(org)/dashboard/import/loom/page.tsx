import type { Metadata } from "next";
import { ImportLoomPage } from "./ImportLoomPage";

export const metadata: Metadata = {
	title: "Import from Loom — Cap",
};

export default function Page() {
	return <ImportLoomPage />;
}
