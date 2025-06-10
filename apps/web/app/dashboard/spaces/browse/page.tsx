"use client";
import { useState } from "react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import Image from "next/image";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";

import { Search } from "lucide-react";
import { Input } from "@cap/ui";
import { useRouter } from "next/navigation";
import { Button } from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEdit, faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import SpaceDialog from "../../_components/AdminNavbar/SpaceDialog";

import { Spaces } from "../../layout";
import { deleteSpace } from "@/actions/organization/delete-space";
import { toast } from "sonner";
import { useParams } from "next/navigation";

export default function BrowseSpacesPage() {
  const { spacesData, user, activeOrganization } = useSharedContext();
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);
  const [editSpace, setEditSpace] = useState<any | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const filteredSpaces = spacesData?.filter((space: Spaces) =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const router = useRouter();
  const params = useParams();

  const handleDeleteSpace = async (e: React.MouseEvent, spaceId: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (
      confirm(
        "Are you sure you want to delete this space? This action cannot be undone."
      )
    ) {
      try {
        const result = await deleteSpace(spaceId);

        if (result.success) {
          toast.success("Space deleted successfully");

          router.refresh();

          // If we're currently on the deleted space's page, redirect to dashboard
          if (params.spaceId === spaceId) {
            router.push("/dashboard");
          }
        } else {
          toast.error(result.error || "Failed to delete space");
        }
      } catch (error) {
        console.error("Error deleting space:", error);
        toast.error("Failed to delete space");
      }
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-3 justify-between items-start mb-4 w-full">
        <Button
          onClick={() => setShowSpaceDialog(true)}
          size="sm"
          variant="primary"
        >
          <FontAwesomeIcon className="size-2.5" icon={faPlus} />
          Create Space
        </Button>
        <div className="flex relative w-full max-w-md">
          <div className="flex absolute inset-y-0 left-3 items-center pointer-events-none">
            <Search className="size-4 text-gray-9" />
          </div>
          <Input
            type="text"
            placeholder="Search spaces..."
            className="flex-1 pr-3 pl-8 w-full min-w-full text-sm placeholder-gray-8"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-3">
        <table className="min-w-full bg-gray-1">
          <thead>
            <tr className="text-sm text-left text-gray-10">
              <th className="px-6 py-3 font-medium">Name</th>
              <th className="px-6 py-3 font-medium">Members</th>
              <th className="px-6 py-3 font-medium">Videos</th>
              <th className="px-6 py-3 font-medium">Role</th>
              <th className="px-6 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!spacesData && (
              <tr>
                <td colSpan={5} className="px-6 py-6 text-center text-gray-8">
                  Loading Spaces…
                </td>
              </tr>
            )}
            {spacesData && filteredSpaces && filteredSpaces.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-6 text-center text-gray-8">
                  No spaces found.
                </td>
              </tr>
            )}
            {filteredSpaces &&
              filteredSpaces.map((space: Spaces) => {
                const isOwner = user?.id === space.createdById;
                return (
                  <tr
                    key={space.id}
                    onClick={() => router.push(`/dashboard/spaces/${space.id}`)}
                    className="border-t transition-colors cursor-pointer hover:bg-gray-2 border-gray-3"
                  >
                    <td className="flex gap-3 items-center px-6 py-3">
                      {space.iconUrl ? (
                        <Image
                          src={space.iconUrl}
                          alt={space.name}
                          width={24}
                          height={24}
                          className="object-cover w-7 h-7 rounded-full"
                        />
                      ) : (
                        <Avatar
                          className="relative flex-shrink-0 size-7"
                          letterClass="text-sm"
                          name={space.name}
                        />
                      )}
                      <span className="text-sm font-semibold text-gray-12">
                        {space.name}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-sm text-gray-12">
                      {space.memberCount} member
                      {space.memberCount === 1 ? "" : "s"}
                    </td>
                    <td className="px-6 py-3 text-sm text-gray-12">
                      {space.videoCount} video
                      {space.videoCount === 1 ? "" : "s"}
                    </td>
                    <td className="px-6 py-3 text-sm text-gray-12">
                      {space.createdById === user?.id ? "Admin" : "Member"}
                    </td>
                    <td className="flex gap-3 px-6 py-3 text-right">
                      {space.createdById === user?.id && !space.primary ? (
                        <>
                          <Button
                            variant="gray"
                            className="size-8 p-0 min-w-[unset]"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditSpace({
                                id: space.id,
                                name: space.name,
                                members: (
                                  activeOrganization?.members || []
                                ).map((m) => m.user.id),
                                iconUrl: space.iconUrl,
                              });
                              setShowSpaceDialog(true);
                            }}
                          >
                            <FontAwesomeIcon icon={faEdit} className="size-3" />
                          </Button>
                          <Button
                            variant="gray"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSpace(e, space.id);
                            }}
                            className="size-8 p-0 min-w-[unset]"
                            size="sm"
                          >
                            <FontAwesomeIcon
                              icon={faTrash}
                              className="size-3"
                            />
                          </Button>
                        </>
                      ) : (
                        <div>
                          <p>...</p>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <SpaceDialog
        open={showSpaceDialog}
        excludeCurrentUser
        onClose={() => {
          setShowSpaceDialog(false);
          setEditSpace(null);
        }}
        edit={!!editSpace}
        space={editSpace}
        onSpaceUpdated={() => {
          setShowSpaceDialog(false);
          setEditSpace(null);
          router.refresh();
        }}
      />
    </div>
  );
}
