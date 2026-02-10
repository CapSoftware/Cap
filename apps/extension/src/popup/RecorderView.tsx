import { Button, Logo } from "@cap/ui";
import { toast } from "sonner";
import { CAP_WEB_ORIGIN } from "@/lib/cap-web";
import type { ExtensionMeResponse } from "@/lib/me";
import { WebRecorderPanel } from "@/recorder/web-recorder-dialog";

const pickOrgId = (me: ExtensionMeResponse) => {
	const preferred = me.user.activeOrganizationId ?? me.user.defaultOrgId;
	if (preferred) return preferred;
	const first = me.organizations[0]?.id;
	return first ?? null;
};

export const RecorderView = ({
	me,
	apiKey,
	onSignOut,
}: {
	me: ExtensionMeResponse;
	apiKey: string;
	onSignOut: () => void;
}) => {
	const orgId = pickOrgId(me);

	if (!orgId) {
		return (
			<div className="h-full w-full p-4">
				<div className="w-full rounded-xl border border-gray-4 bg-gray-1 p-5">
					<div className="flex items-center justify-between">
						<Logo className="h-8 w-auto" hideLogoName />
						<Button variant="transparent" size="sm" onClick={onSignOut}>
							Sign out
						</Button>
					</div>
					<div className="mt-4 text-sm text-gray-11">
						No organization found for this account.
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full w-full p-3">
			<div className="flex items-center justify-between pb-2">
				<Logo className="h-8 w-auto" hideLogoName />
				<div className="flex items-center gap-2">
					<Button
						variant="transparent"
						size="sm"
						onClick={() => {
							try {
								window.open(
									`${CAP_WEB_ORIGIN}/dashboard`,
									"_blank",
									"noopener",
								);
							} catch {
								toast.error("Failed to open dashboard");
							}
						}}
					>
						Dashboard
					</Button>
					<Button variant="transparent" size="sm" onClick={onSignOut}>
						Sign out
					</Button>
				</div>
			</div>
			<WebRecorderPanel
				organisationId={orgId}
				isProUser={me.user.isPro}
				apiKey={apiKey}
			/>
		</div>
	);
};
