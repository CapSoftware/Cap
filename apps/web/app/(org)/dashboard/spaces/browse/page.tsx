"use client";

import { useState } from "react";
import Image from "next/image";

import { Search } from "lucide-react";
import { Input } from "@cap/ui";
import { useRouter } from "next/navigation";
import { Button, Avatar } from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEdit, faLayerGroup, faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import SpaceDialog from "../../_components/Navbar/SpaceDialog";
import { ConfirmationDialog } from "../../_components/ConfirmationDialog";

import { Spaces } from "../../dashboard-data";
import { deleteSpace } from "@/actions/organization/delete-space";
import { toast } from "sonner";
import { useParams } from "next/navigation";
import { useDashboardContext } from "../../Contexts";

export default function BrowseSpacesPage() {
  const { spacesData, user, activeOrganization } = useDashboardContext();
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);
  const [editSpace, setEditSpace] = useState<any | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const trueActiveOrgMembers = activeOrganization?.members.filter((m) => m.user?.id !== user?.id);


  const filteredSpaces = spacesData?.filter((space: Spaces) =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const router = useRouter();
  const params = useParams();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeleteSpace, setPendingDeleteSpace] = useState<Spaces | null>(null);
  const [removing, setRemoving] = useState(false);

  const handleDeleteSpace = (e: React.MouseEvent, space: Spaces) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingDeleteSpace(space);
    setConfirmOpen(true);
  };

  const confirmRemoveSpace = async () => {
    if (!pendingDeleteSpace) return;
    setRemoving(true);
    try {
      const result = await deleteSpace(pendingDeleteSpace.id);
      if (result.success) {
        toast.success("Space deleted successfully");
        router.refresh();
        if (params.spaceId === pendingDeleteSpace.id) {
          router.push("/dashboard");
        }
      } else {
        toast.error(result.error || "Failed to delete space");
      }
    } catch (error) {
      console.error("Error deleting space:", error);
      toast.error("Failed to delete space");
    } finally {
      setRemoving(false);
      setConfirmOpen(false);
      setPendingDeleteSpace(null);
    }
  };

  return (
    <>
      <div>
        <div className="flex flex-wrap gap-3 justify-between items-start mb-4 w-full">
          <Button
            onClick={() => setShowSpaceDialog(true)}
            size="sm"
            variant="dark"
          >
            <FontAwesomeIcon className="size-3" icon={faPlus} />
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
                return (
                  <tr
                    key={space.id}
                    onClick={() => router.push(`/dashboard/spaces/${space.id}`)}
                    className="border-t transition-colors cursor-pointer hover:bg-gray-2 border-gray-3"
                  >
                    <td className="flex gap-3 items-center px-6 py-4">
                      {space.iconUrl ? (
                        <Image
                          src={space.iconUrl}
                          alt={space.name}
                          width={24}
                          height={24}
                          className="object-cover flex-shrink-0 w-7 h-7 rounded-full"
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
                    <td className="px-6 py-4 text-sm text-gray-12">
                      {space.memberCount} member
                      {space.memberCount === 1 ? "" : "s"}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-12">
                      {space.videoCount} video
                      {space.videoCount === 1 ? "" : "s"}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-12">
                      {space.createdById === user?.id ? "Admin" : "Member"}
                    </td>
                    <td className="px-6">
                      {space.createdById === user?.id && !space.primary ? (
                        <div className="flex gap-2">
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
                                  trueActiveOrgMembers || []
                                ).map(
                                  (m: { user: { id: string } }) => m.user.id
                                ),
                                iconUrl: space.iconUrl,
                              });
                              setShowSpaceDialog(true);
                            }}
                          >
                            <FontAwesomeIcon icon={faEdit} className="size-3" />
                          </Button>
                          <Button
                            variant="gray"
                            onClick={(e) => handleDeleteSpace(e, space)}
                            className="size-8 p-0 min-w-[unset]"
                            size="sm"
                          >
                            <FontAwesomeIcon
                              icon={faTrash}
                              className="size-3"
                            />
                          </Button>
                        </div>
                      ) : (
                        <div className="h-[32px]">
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
      <ConfirmationDialog
        open={confirmOpen}
        icon={<FontAwesomeIcon icon={faLayerGroup} />}
        title="Delete space"
        description={pendingDeleteSpace ? `Are you sure you want to delete the space "${pendingDeleteSpace?.name || 'selected'}"? This action cannot be undone.` : 'Are you sure you want to delete this space? This action cannot be undone.'}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        loading={removing}
        onConfirm={confirmRemoveSpace}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingDeleteSpace(null);
        }}
      />
    </>
  );
}
