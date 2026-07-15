import type { Metadata } from "next";
import { AppsListClient } from "./AppsListClient";

export const metadata: Metadata = {
	title: "开发者应用 — Cap",
};

export default async function AppsPage() {
	return <AppsListClient />;
}
