import type { Metadata } from "next";
import { ImportPage } from "./ImportPage";

export const metadata: Metadata = {
	title: "Import — Cap",
};

export default function Page() {
	return <ImportPage />;
}
