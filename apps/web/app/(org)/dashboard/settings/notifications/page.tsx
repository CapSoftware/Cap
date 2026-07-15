import type { Metadata } from "next";
import { NotificationsSettings } from "./NotificationsSettings";

export const metadata: Metadata = {
	title: "通知设置 — Cap",
};

export default function NotificationsSettingsPage() {
	return <NotificationsSettings />;
}
