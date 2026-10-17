import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { and, eq, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { LoomStep } from "../components/LoomStep";
import { RecordStep } from "../components/RecordStep";
import { StartStep } from "../components/StartStep";
import { UploadStep } from "../components/UploadStep";
import { WelcomeStep } from "../components/WelcomeStep";
import {
	ONBOARDING_NEXT_COOKIE,
	onboardingContinuePath,
	onboardingHrefForIntent,
	onboardingIntentFromNextPath,
	onboardingStepHref,
	resolveOnboardingStep,
} from "../onboarding-flow";

type SearchParams = Record<string, string | string[] | undefined>;

const firstParam = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

async function getOnboardingOrganization(
	user: Pick<CurrentUser, "id" | "activeOrganizationId" | "defaultOrgId">,
) {
	const organizationId = user.activeOrganizationId || user.defaultOrgId;
	if (!organizationId) return null;

	const [row] = await db()
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
			memberRole: organizationMembers.role,
		})
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, user.id),
			),
		)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);

	if (!row) return null;
	const isOwner = row.ownerId === user.id;
	if (!isOwner && !row.memberRole) return null;

	return {
		id: row.id,
		name: row.name,
		isOwner,
		canManage: canManageOrganizationSettings(
			getEffectiveOrganizationRole({
				userId: user.id,
				ownerId: row.ownerId,
				memberRole: row.memberRole,
			}),
		),
	};
}

export default async function OnboardingStepPage({
	params,
	searchParams,
}: {
	params: Promise<{ steps?: string[] }>;
	searchParams: Promise<SearchParams>;
}) {
	const user = await getCurrentUser();
	if (!user) redirect("/login");

	const resolution = resolveOnboardingStep((await params).steps?.[0], user);
	if (resolution.kind === "redirect") {
		redirect(onboardingStepHref(resolution.step));
	}

	const query = await searchParams;
	const intent = onboardingIntentFromNextPath(
		(await cookies()).get(ONBOARDING_NEXT_COOKIE)?.value,
	);
	const organization = await getOnboardingOrganization(user);
	const teamName =
		organization && !organization.isOwner ? organization.name : null;
	const completed =
		user.onboardingSteps?.getStarted !== false && organization !== null;
	const isPro = userIsPro(user);

	switch (resolution.step) {
		case "welcome":
			return (
				<WelcomeStep
					organizationName={teamName}
					nextHref={onboardingHrefForIntent(intent)}
				/>
			);
		case "start":
			return (
				<StartStep
					firstName={user.name?.trim() ?? ""}
					organizationName={teamName}
					continuePath={onboardingContinuePath(intent)}
					completed={completed}
				/>
			);
		case "loom":
			return (
				<LoomStep
					key={firstParam(query.url) ?? ""}
					organizationId={organization?.id ?? null}
					initialUrl={firstParam(query.url)?.trim() ?? ""}
					bulk={firstParam(query.bulk) === "1"}
					canBulkImport={organization?.canManage ?? false}
					isPro={isPro}
					justUpgraded={firstParam(query.upgrade) === "true"}
					completed={completed}
				/>
			);
		case "record":
			return (
				<RecordStep isPro={isPro} email={user.email} completed={completed} />
			);
		case "upload":
			return (
				<UploadStep
					organizationId={organization?.id ?? null}
					isPro={isPro}
					justUpgraded={firstParam(query.upgrade) === "true"}
					completed={completed}
				/>
			);
	}
}
