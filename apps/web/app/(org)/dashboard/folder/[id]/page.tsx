import {
  ClientMyCapsLink,
  NewSubfolderButton,
  BreadcrumbItem,
} from "./components";
import Folder from "../../caps/components/Folder";
import { getFolderBreadcrumb } from "@/actions/folders/getFolderBreadcrumb";
import { getChildFolders } from "@/actions/folders/getChildFolders";
import { getVideosByFolderId } from "@/actions/folders/getVideosByFolderId";
import { serverEnv } from "@cap/env";
import { UploadCapButtonWithFolder } from "./components/UploadCapButtonWithFolder";
import FolderVideosSection from "./components/FolderVideosSection";

const FolderPage = async ({ params }: { params: { id: string } }) => {
  const [childFolders, breadcrumb, videosData] = await Promise.all([
    getChildFolders(params.id),
    getFolderBreadcrumb(params.id),
    getVideosByFolderId(params.id),
  ]);

  return (
    <div>
      <div className="flex gap-2 items-center mb-10">
        <NewSubfolderButton parentFolderId={params.id} />
        <UploadCapButtonWithFolder folderId={params.id} />
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
};

export default FolderPage;
