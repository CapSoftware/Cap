import { getChildFolders, getFolderBreadcrumb, getVideosByFolderId } from "./actions";
import { ClientMyCapsLink, NewSubfolderButton, BreadcrumbItem, ClientCapCard } from "./components";
import Folder from "../../caps/components/Folder";

const FolderPage = async ({ params }: {
  params: { id: string }
}) => {
  const [childFolders, breadcrumb, videosData] = await Promise.all([
    getChildFolders(params.id),
    getFolderBreadcrumb(params.id),
    getVideosByFolderId(params.id),
  ]);


  return (
    <div>
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
        {videosData.length === 0 ? (
          <p className="col-span-full text-gray-9">No videos in this folder yet. Drag and drop videos here to add them.</p>
        ) : (
          videosData.map((video) => (
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
