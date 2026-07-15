import type { Metadata } from "next";
import { AppSettingsClient } from "./AppSettingsClient";

export const metadata: Metadata = {
	title: "应用设置 — Cap",
};

export default async function AppSettingsPage() {
	return <AppSettingsClient />;
}
