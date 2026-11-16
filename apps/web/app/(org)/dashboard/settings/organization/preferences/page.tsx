import type { Metadata } from "next";
import CapSettingsCard from "../components/CapSettingsCard";
import { DefaultVideoVisibility } from "../components/DefaultVideoVisibility";

export const metadata: Metadata = {
	title: "Organization Preferences — Cap",
};

export default function PreferencesPage() {
	return (
		<div className="flex flex-col gap-10">
			<DefaultVideoVisibility />
			<CapSettingsCard />
		</div>
	);
}
