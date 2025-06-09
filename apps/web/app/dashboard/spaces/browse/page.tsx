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
import {
  faEdit,
  faEllipsis,
  faPlus,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import SpaceDialog from "../../_components/AdminNavbar/SpaceDialog";
import { spaces } from "@cap/database/schema";
import { Spaces } from "../../layout";

export default function BrowseSpacesPage() {
  const { spacesData, user } = useSharedContext();
  const [searchQuery, setSearchQuery] = useState("");
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);

  const filteredSpaces = spacesData?.filter((space: Spaces) =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const router = useRouter();
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
            </tr>
          </thead>
          <tbody>
            {!spacesData && (
              <tr>
                <td colSpan={4} className="px-6 py-6 text-center text-gray-8">
                  Loading Spaces…
                </td>
              </tr>
            )}
            {spacesData && filteredSpaces && filteredSpaces.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-6 text-center text-gray-8">
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
                      {space.createdById === user?.id ? "Owner" : "Member"}
                    </td>
                    {isOwner && (
                      <td
                        onClick={(e) => e.stopPropagation()}
                        className="flex relative z-10 items-center px-6 py-3 space-x-3 text-sm text-gray-12"
                      >
                        <div className="flex justify-center items-center rounded-full transition-colors cursor-pointer size-8 bg-gray-3 hover:bg-gray-4">
                          <FontAwesomeIcon className="size-3" icon={faEdit} />
                        </div>
                        <div className="flex justify-center items-center rounded-full transition-colors cursor-pointer size-8 bg-gray-3 hover:bg-gray-4">
                          <FontAwesomeIcon className="size-3" icon={faTrash} />
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <SpaceDialog
        open={showSpaceDialog}
        onClose={() => setShowSpaceDialog(false)}
      />
    </div>
  );
}
