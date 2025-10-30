import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { makeCurrentUserLayer, Spaces } from "@cap/web-backend";
import { type Folder, Space } from "@cap/web-domain";
import { Effect } from "effect";
import { notFound } from "next/navigation";
import FolderCard from "@/app/(org)/dashboard/caps/components/Folder";
import {
	getChildFolders,
	getFolderBreadcrumb,
	getVideosByFolderId,
} from "@/lib/folder";
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

		const [childFolders, breadcrumb, videosData] = yield* Effect.all([
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
		]);

		return (
			<div>
				<div className="flex gap-2 items-center mb-10">
					<NewSubfolderButton parentFolderId={params.folderId} />
					<AddVideosButton
						folderId={params.folderId}
						spaceId={params.spaceId}
						folderName={breadcrumb[breadcrumb.length - 1]?.name ?? "Folder"}
					/>
				</div>
				<div className="flex justify-between items-center mb-6 w-full">
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
									spaceId={params.spaceId}
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
					dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
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
