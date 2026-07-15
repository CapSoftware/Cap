import type { Metadata } from "next";
import { ImportLoomPage } from "./ImportLoomPage";

export const metadata: Metadata = {
	title: "从 Loom 导入 — Cap",
};

export default function Page() {
	return <ImportLoomPage />;
}
