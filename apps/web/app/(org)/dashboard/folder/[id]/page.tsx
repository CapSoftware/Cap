import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { makeCurrentUserLayer } from "@cap/web-backend";
import { Folder } from "@cap/web-domain";
import { Effect } from "effect";
import { notFound } from "next/navigation";
import {
	getChildFolders,
	getFolderBreadcrumb,
	getFolderById,
	getVideosByFolderId,
} from "@/lib/folder";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import { runPromise } from "@/lib/server";

import { CollectionShareControl } from "../../_components/CollectionShareControl";
import { UploadCapButton } from "../../caps/components";
import FolderCard from "../../caps/components/Folder";
import { WebRecorderDialog } from "../../caps/components/web-recorder-dialog/web-recorder-dialog";
import {
	BreadcrumbItem,
	ClientMyCapsLink,
	NewSubfolderButton,
} from "./components";
import FolderVideosSection from "./components/FolderVideosSection";

const FolderPage = async (props: PageProps<"/dashboard/folder/[id]">) => {
	const params = await props.params;
	const folderId = Folder.FolderId.make(params.id);

	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId) return notFound();

	return Effect.gen(function* () {
		const [childFolders, breadcrumb, videosData, share] = yield* Effect.all(
			[
				getChildFolders(folderId, { variant: "user" }),
				getFolderBreadcrumb(folderId),
				getVideosByFolderId(folderId, {
					variant: "user",
				}),
				Effect.gen(function* () {
					const folder = yield* getFolderById(folderId);
					// Mirrors FoldersPolicy.canEdit for personal folders: only the
					// creator may manage sharing; the Pro gate uses the folder's own
					// organization, which is what the server enforces on writes.
					const canManage =
						folder.spaceId === null && folder.createdById === user.id;
					const ownerIsPro = canManage
						? yield* Effect.promise(() =>
								isOrganizationOwnerPro(folder.organizationId),
							)
						: false;
					return { folder, canManage, ownerIsPro };
				}),
			],
			{ concurrency: "unbounded" },
		);

		return (
			<div>
				<div className="flex flex-wrap gap-2 items-center mb-10">
					<NewSubfolderButton parentFolderId={folderId} />
					<UploadCapButton size="sm" />
					<WebRecorderDialog />
					<CollectionShareControl
						kind="folder"
						collectionId={folderId}
						isPublic={share.folder.public}
						canManage={share.canManage}
						isPro={share.ownerIsPro}
						settings={
							share.canManage
								? (share.folder.settings?.publicPage ?? null)
								: null
						}
					/>
				</div>
				<div className="flex flex-wrap gap-3 items-center mb-6 w-full">
					<div className="flex overflow-x-auto items-center font-medium">
						<ClientMyCapsLink />

						{breadcrumb.map((folder, index) => (
							<div key={folder.id} className="flex items-center">
								<p className="mx-2 text-gray-10">/</p>
								<BreadcrumbItem
									id={folder.id}
									name={folder.name}
									color={folder.color}
									isLast={index === breadcrumb.length - 1}
								/>
							</div>
						))}
					</div>
				</div>

				{/* Display Child Folders */}
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
									id={folder.id}
									parentId={folder.parentId}
									videoCount={folder.videoCount}
								/>
							))}
						</div>
					</>
				)}

				{/* Display Videos */}
				<FolderVideosSection
					initialVideos={videosData}
					analyticsEnabled={Boolean(
						serverEnv().TINYBIRD_TOKEN && serverEnv().TINYBIRD_HOST,
					)}
				/>
			</div>
		);
	}).pipe(Effect.provide(makeCurrentUserLayer(user)), runPromise);
};

export default FolderPage;
