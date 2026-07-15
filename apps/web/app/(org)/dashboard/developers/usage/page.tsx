import type { Metadata } from "next";
import { UsageClient } from "./UsageClient";

export const metadata: Metadata = {
	title: "开发者用量 — Cap",
};

export default async function UsagePage() {
	return <UsageClient />;
}
