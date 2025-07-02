import { getFolderById, getChildFolders, getFolderBreadcrumb, getVideosByFolderId } from "./actions";
import Link from 'next/link';
import { NewSubfolderButton } from "./components/NewSubfolderButton";
import Folder from "../../caps/components/Folder";
import { ClientCapCard } from "./components/ClientCapCard";
import { ClientBreadcrumbItem } from "./components/ClientBreadcrumbItem";

const FolderPage = async ({ params }: {
  params: { id: string }
}) => {
  const folderData = await getFolderById(params.id);
  const childFolders = await getChildFolders(params.id);
  const breadcrumb = await getFolderBreadcrumb(params.id);

  // Fetch videos in this folder using the action function
  const processedVideoData = await getVideosByFolderId(params.id);

  return (
    <div>
      <div className="flex justify-between items-center mb-6 w-full">
        <div className="flex overflow-x-auto items-center font-medium">
          <Link href="/dashboard/caps" className="text-xl whitespace-nowrap transition-colors duration-200 text-gray-9 hover:text-gray-12">
            My Caps
          </Link>

          {breadcrumb.map((folder, index) => (
            <div key={folder.id} className="flex items-center">
              <p className="mx-2 text-gray-10">/</p>
              <ClientBreadcrumbItem
                id={folder.id}
                name={folder.name}
                color={folder.color}
                isLast={index === breadcrumb.length - 1}
              />
            </div>
          ))}
        </div>
        <NewSubfolderButton parentFolderId={params.id} />
      </div>

      {/* Display Child Folders */}
      {childFolders.length > 0 && (
        <>
          <h1 className="mb-3 text-xl font-medium text-gray-12">Subfolders</h1>
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
      <h1 className="mb-3 text-xl font-medium text-gray-12">Videos</h1>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {processedVideoData.length === 0 ? (
          <p className="col-span-full text-gray-9">No videos in this folder yet. Drag and drop videos here to add them.</p>
        ) : (
          processedVideoData.map((video) => (
            <ClientCapCard
              key={video.id}
              videoId={video.id}
              cap={video}
              analytics={0}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default FolderPage;
