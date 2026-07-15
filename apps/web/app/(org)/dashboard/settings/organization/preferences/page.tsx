import type { Metadata } from "next";
import CapSettingsCard from "../components/CapSettingsCard";

export const metadata: Metadata = {
	title: "组织偏好设置 — Cap",
};

export default function PreferencesPage() {
	return <CapSettingsCard />;
}
