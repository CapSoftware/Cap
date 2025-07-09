import { ClientMyCapsLink, NewSubfolderButton, BreadcrumbItem } from "../../../../folder/[id]/components";
import Folder from "@/app/(org)/dashboard/caps/components/Folder";
import { getFolderBreadcrumb } from "@/actions/folders/getFolderBreadcrumb";
import { getChildFolders } from "@/actions/folders/getChildFolders";
import { getVideosByFolderId } from "@/actions/folders/getVideosByFolderId";
import { serverEnv } from "@cap/env";
import FolderVideosSection from "../../../../folder/[id]/components/FolderVideosSection";
import { getCurrentUser } from "@cap/database/auth/session";

const FolderPage = async ({ params }: { params: { spaceId: string; folderId: string } }) => {
  const [childFolders, breadcrumb, videosData] = await Promise.all([
    getChildFolders(params.folderId),
    getFolderBreadcrumb(params.folderId),
    getVideosByFolderId(params.folderId),
  ]);
  const user = await getCurrentUser();
  const userId = user?.id as string;

  return (
    <div>
      <div className="flex gap-2 items-center mb-10">
        <NewSubfolderButton parentFolderId={params.folderId} />
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
          <h1 className="mb-6 text-xl font-medium text-gray-12">Subfolders</h1>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 mb-10">
            {childFolders.map((folder) => (
              <Folder
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
        cardType="shared"
        initialVideos={videosData}
        dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
        userId={userId}
      />
    </div>
  );
};

export default FolderPage;
