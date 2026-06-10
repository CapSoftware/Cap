import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { makeCurrentUserLayer, Spaces } from "@cap/web-backend";
import { type Folder, type Organisation, Space } from "@cap/web-domain";
import { Effect } from "effect";
import { notFound } from "next/navigation";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";
import { CollectionShareControl } from "@/app/(org)/dashboard/_components/CollectionShareControl";
import FolderCard from "@/app/(org)/dashboard/caps/components/Folder";
import {
	getChildFolders,
	getFolderBreadcrumb,
	getFolderById,
	getVideosByFolderId,
} from "@/lib/folder";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import { canManageSpace } from "@/lib/permissions/roles";
import { runPromise } from "@/lib/server";
import {
	BreadcrumbItem,
	ClientMyCapsLink,
	NewSubfolderButton,
} from "../../../../folder/[id]/components";
import FolderVideosSection from "../../../../folder/[id]/components/FolderVideosSection";
import AddVideosButton from "./AddVideosButton";

const FolderPage = async (props: {
	params: Promise<{
		spaceId: Space.SpaceIdOrOrganisationId;
		folderId: Folder.FolderId;
	}>;
}) => {
	const params = await props.params;
	const user = await getCurrentUser();
	if (!user) return notFound();

	return await Effect.gen(function* () {
		const spaces = yield* Spaces;
		const spaceOrOrg = yield* spaces.getSpaceOrOrg(
			Space.SpaceId.make(params.spaceId),
		);
		if (!spaceOrOrg) notFound();

		const orgId: Organisation.OrganisationId =
			spaceOrOrg.variant === "space"
				? spaceOrOrg.space.organizationId
				: spaceOrOrg.organization.id;

		const spaceManagementAccess =
			spaceOrOrg.variant === "space"
				? Effect.promise(() => getSpaceAccess(user.id, spaceOrOrg.space.id))
				: Effect.succeed(null);
		const orgManagementAccess =
			spaceOrOrg.variant === "space"
				? Effect.succeed(null)
				: Effect.promise(() => getOrganizationAccess(user.id, orgId));

		const [
			childFolders,
			breadcrumb,
			videosData,
			currentFolder,
			ownerIsPro,
			managementAccess,
			orgAccess,
		] = yield* Effect.all(
			[
				getChildFolders(
					params.folderId,
					spaceOrOrg.variant === "space"
						? { variant: "space", spaceId: spaceOrOrg.space.id }
						: { variant: "org", organizationId: spaceOrOrg.organization.id },
				),
				getFolderBreadcrumb(params.folderId),
				getVideosByFolderId(
					params.folderId,
					spaceOrOrg.variant === "space"
						? { variant: "space", spaceId: spaceOrOrg.space.id }
						: { variant: "org", organizationId: spaceOrOrg.organization.id },
				),
				getFolderById(params.folderId),
				Effect.promise(() => isOrganizationOwnerPro(orgId)),
				spaceManagementAccess,
				orgManagementAccess,
			],
			// Independent reads — without this, Effect.all runs them sequentially
			// and every page view pays the roundtrips back to back.
			{ concurrency: "unbounded" },
		);
		// Mirrors FoldersPolicy.canEdit so the share control is only shown to
		// users the server would actually allow: space folders need space/org
		// management; org-wide folders need org management. The folder must also
		// actually belong to the routed space/org — getFolderById is unscoped,
		// so a foreign folderId must not surface another collection's settings.
		const folderBelongsToContext = currentFolder.spaceId === params.spaceId;
		const canManageCollection =
			folderBelongsToContext &&
			(spaceOrOrg.variant === "space"
				? Boolean(managementAccess?.canManage)
				: canManageSpace({
						organizationRole: orgAccess?.role,
						spaceRole: null,
					}));

		return (
			<div>
				<div className="flex gap-2 items-center mb-10">
					<NewSubfolderButton parentFolderId={params.folderId} />
					<AddVideosButton
						folderId={params.folderId}
						spaceId={params.spaceId}
						folderName={breadcrumb[breadcrumb.length - 1]?.name ?? "Folder"}
					/>
					<CollectionShareControl
						kind="folder"
						collectionId={params.folderId}
						isPublic={currentFolder.public}
						canManage={canManageCollection}
						isPro={ownerIsPro}
						settings={
							canManageCollection
								? (currentFolder.settings?.publicPage ?? null)
								: null
						}
					/>
				</div>
				<div className="flex flex-wrap gap-3 items-center mb-6 w-full">
					<div className="flex overflow-x-auto items-center font-medium">
						<ClientMyCapsLink spaceId={params.spaceId} />
						{breadcrumb.map((folder, index) => (
							<div key={folder.id} className="flex items-center">
								<p className="mx-2 text-gray-10">/</p>
								<BreadcrumbItem
									spaceId={params.spaceId}
									id={folder.id}
									name={folder.name}
									color={folder.color}
									isLast={index === breadcrumb.length - 1}
								/>
							</div>
						))}
					</div>
				</div>
				{childFolders.length > 0 && (
					<>
						<h1 className="mb-6 text-xl font-medium text-gray-12">
							Subfolders
						</h1>
						<div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 mb-10">
							{childFolders.map((folder) => (
								<FolderCard
									key={folder.id}
									name={folder.name}
									color={folder.color}
									public={folder.public}
									spaceId={params.spaceId}
									id={folder.id}
									parentId={folder.parentId}
									videoCount={folder.videoCount}
								/>
							))}
						</div>
					</>
				)}
				<FolderVideosSection
					initialVideos={videosData}
					analyticsEnabled={Boolean(
						serverEnv().TINYBIRD_TOKEN && serverEnv().TINYBIRD_HOST,
					)}
				/>
			</div>
		);
	}).pipe(
		Effect.catchTag("PolicyDenied", () => Effect.sync(() => notFound())),
		Effect.provide(makeCurrentUserLayer(user)),
		runPromise,
	);
};

export default FolderPage;
