import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env/server";
import { CurrentUser, type Folder } from "@cap/web-domain";
import { Effect } from "effect";
import { notFound } from "next/navigation";
import {
	getChildFolders,
	getFolderBreadcrumb,
	getVideosByFolderId,
} from "@/lib/folder";
import { runPromise } from "@/lib/server";
import { UploadCapButton } from "../../caps/components";
import FolderCard from "../../caps/components/Folder";
import {
	BreadcrumbItem,
	ClientMyCapsLink,
	NewSubfolderButton,
} from "./components";
import FolderVideosSection from "./components/FolderVideosSection";

const FolderPage = async ({ params }: { params: { id: Folder.FolderId } }) => {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId) return notFound();

	return Effect.gen(function* () {
		const [childFolders, breadcrumb, videosData] = yield* Effect.all([
			getChildFolders(params.id, { variant: "user" }),
			getFolderBreadcrumb(params.id),
			getVideosByFolderId(params.id),
		]);

		return (
			<div>
				<div className="flex gap-2 items-center mb-10">
					<NewSubfolderButton parentFolderId={params.id} />
					<UploadCapButton size="sm" folderId={params.id} />
				</div>
				<div className="flex justify-between items-center mb-6 w-full">
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
	}).pipe(Effect.provideService(CurrentUser, user), runPromise);
};

export default FolderPage;
