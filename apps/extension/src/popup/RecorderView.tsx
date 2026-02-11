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
	const handleOpenDashboard = () => {
		try {
			window.open(`${CAP_WEB_ORIGIN}/dashboard`, "_blank", "noopener");
		} catch {
			toast.error("Failed to open dashboard");
		}
	};

	if (!orgId) {
		return (
			<div className="h-full w-full p-4">
				<div className="w-full rounded-xl border border-gray-4 bg-gray-1 p-5">
					<div className="flex items-center justify-between">
						<Logo className="h-8 w-auto" />
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
			<WebRecorderPanel
				organisationId={orgId}
				isProUser={me.user.isPro}
				apiKey={apiKey}
				onOpenDashboard={handleOpenDashboard}
				onSignOut={onSignOut}
			/>
		</div>
	);
};
