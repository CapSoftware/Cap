import type { Metadata } from "next";
import { ImportPage } from "./ImportPage";

export const metadata: Metadata = {
	title: "Import",
};

export default function Page() {
	return <ImportPage />;
}
