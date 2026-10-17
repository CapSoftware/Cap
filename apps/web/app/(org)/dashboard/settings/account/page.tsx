import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import Link from "next/link";
import { CliApiKeys } from "./components/CliApiKeys";
import { Settings } from "./Settings";
import { listCliApiKeys } from "./server";

export const metadata: Metadata = {
	title: "Settings — Cap",
};

export default async function SettingsPage() {
	// A failed key query must not 500 the whole settings page, but it also must not render as
	// an empty list, which would hide still-active keys the user may need to revoke.
	const cliApiKeys = await listCliApiKeys().catch(() => null);
	return (
		<>
			{buildEnv.NEXT_PUBLIC_IS_CAP && (
				<Link
					href="/dashboard/settings/invoices"
					className="mb-4 inline-block text-sm font-medium underline"
				>
					View invoices and receipts
				</Link>
			)}
			<Settings />
			<CliApiKeys
				initialKeys={cliApiKeys ?? []}
				loadFailed={cliApiKeys === null}
			/>
		</>
	);
}
