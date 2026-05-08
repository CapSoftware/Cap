import type { Metadata } from "next";
import { ImportLoomPage } from "./ImportLoomPage";

export const metadata: Metadata = {
	title: "Import from Loom",
};

export default function Page() {
	return <ImportLoomPage />;
}
