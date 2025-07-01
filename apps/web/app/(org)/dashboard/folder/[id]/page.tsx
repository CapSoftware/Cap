import { getFolderById } from "./actions";
import Link from 'next/link'
import { AllFolders } from "../../caps/components/Folders";

const FolderPage = async ({ params }: {
  params: { id: string }
}) => {
  const folderData = await getFolderById(params.id);

  return (
    <div>
      <div className="flex gap-2 items-center font-medium">
        <Link href="/dashboard/caps" className="text-2xl transition-colors duration-200 cursor-pointer text-gray-10 hover:text-gray-12">
          My Caps
        </Link>
        <p className="text-2xl text-gray-10">/</p>
        <div className="flex gap-1.5 items-center ml-0.5">
          <AllFolders color={folderData.color} className="size-6" />
          <p className="text-2xl text-gray-12">{folderData.name}</p>
        </div>
      </div>
    </div>
  );
};

export default FolderPage;
