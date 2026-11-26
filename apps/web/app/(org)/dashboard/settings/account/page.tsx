import { isEmailManagedByOrganization } from "@cap/database/auth/email-change";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { listMyPasskeys } from "@/actions/auth/passkeys";
import { CliApiKeys } from "./components/CliApiKeys";
import { Passkeys } from "./components/Passkeys";
import { Settings } from "./Settings";
import { listCliApiKeys } from "./server";

export const metadata: Metadata = {
	title: "Settings — Cap",
};

export default async function SettingsPage() {
	// A failed key query must not 500 the whole settings page, but it also must not render as
	// an empty list, which would hide still-active keys the user may need to revoke.
	const [cliApiKeys, passkeys, user] = await Promise.all([
		listCliApiKeys().catch(() => null),
		listMyPasskeys().catch(() => null),
		getCurrentUser(),
	]);
	const emailManaged = user
		? await isEmailManagedByOrganization(user).catch(() => true)
		: true;
	return (
		<div className="flex flex-col gap-10 mx-auto w-full max-w-4xl">
			<Settings
				canUsePasskey={(passkeys ?? []).some(
					(passkey) => passkey.confirmsIdentity,
				)}
				emailManaged={emailManaged}
			/>
			{user && (
				<Passkeys
					email={user.email}
					initialPasskeys={passkeys ?? []}
					loadFailed={passkeys === null}
				/>
			)}
			<CliApiKeys
				initialKeys={cliApiKeys ?? []}
				loadFailed={cliApiKeys === null}
			/>
		</div>
	);
}
