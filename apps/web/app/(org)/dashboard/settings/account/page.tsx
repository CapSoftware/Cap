import type { Metadata } from "next";
import { CliApiKeys } from "./components/CliApiKeys";
import { Settings } from "./Settings";
import { listCliApiKeys } from "./server";

export const metadata: Metadata = {
	title: "Settings — Cap",
};

export default async function SettingsPage() {
	// The key list is an enhancement to the settings page, not a dependency: if the session is
	// mid-redirect or the query hiccups, render the page with an empty list instead of a 500.
	const cliApiKeys = await listCliApiKeys().catch(() => []);
	return (
		<>
			<Settings />
			<CliApiKeys initialKeys={cliApiKeys} />
		</>
	);
}
