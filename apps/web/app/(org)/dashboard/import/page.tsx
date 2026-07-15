import type { Metadata } from "next";
import { ImportPage } from "./ImportPage";

export const metadata: Metadata = {
	title: "导入 — Cap",
};

export default function Page() {
	return <ImportPage />;
}
