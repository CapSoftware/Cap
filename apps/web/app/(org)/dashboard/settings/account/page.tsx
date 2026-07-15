import type { Metadata } from "next";
import { Settings } from "./Settings";

export const metadata: Metadata = {
	title: "账户设置 — Cap",
};

export default async function SettingsPage() {
	return <Settings />;
}
