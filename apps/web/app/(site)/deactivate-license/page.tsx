import type { Metadata } from "next";
import { LicenseDeactivationPage } from "@/components/pages/LicenseDeactivationPage";

export const metadata: Metadata = {
	title: "Deactivate License — Cap",
	description:
		"Deactivate your Cap commercial license from its current device to use it elsewhere.",
	alternates: { canonical: "https://cap.so/deactivate-license" },
};

export default function App() {
	return <LicenseDeactivationPage />;
}
