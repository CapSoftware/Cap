import { getCurrentUser } from "@cap/database/auth/session";
import { hasSsoAccess } from "@cap/utils";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getSignedBaaStatus } from "@/actions/organization/signed-baa";
import { canManageOrganizationBilling } from "@/lib/permissions/roles";
import { getSsoBilling, getSsoPrices } from "@/lib/sso/billing";
import { hasScimSubscription } from "@/lib/sso/scim-billing";
import { type AddOnStatuses, AddOnsSummary } from "../components/AddOnsSummary";

const TERMINAL_SSO_STATUSES = new Set(["canceled", "incomplete_expired"]);

export async function AddOnsStatus() {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) return null;
	const organizationId = user.activeOrganizationId;
	const access = await getOrganizationAccess(user.id, organizationId);
	if (!access || !canManageOrganizationBilling(access.role)) return null;

	const [ssoBilling, ssoPrices, signedBaa] = await Promise.all([
		getSsoBilling(organizationId).catch(() => null),
		getSsoPrices(organizationId).catch(() => []),
		getSignedBaaStatus(organizationId).catch(() => null),
	]);
	const ssoEntitled = hasSsoAccess(ssoBilling);
	const directorySync = ssoEntitled
		? await hasScimSubscription(organizationId).catch(() => false)
		: false;

	const statuses: AddOnStatuses = {
		sso: ssoEntitled
			? "active"
			: ssoBilling?.stripeSubscriptionId &&
					!TERMINAL_SSO_STATUSES.has(ssoBilling.status)
				? "attention"
				: "none",
		ssoPrices,
		directorySync: directorySync ? "active" : "none",
		signedBaa:
			signedBaa?.status === "active" ||
			signedBaa?.status === "paid" ||
			signedBaa?.status === "processing"
				? signedBaa.status
				: "none",
	};

	return <AddOnsSummary statuses={statuses} />;
}
