"use client";
import { useState } from "react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Space } from "../../layout";
import Image from "next/image";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";

import { Search } from "lucide-react";
import { Input } from "@cap/ui";
import { useRouter } from "next/navigation";
import { Button } from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import SpaceDialog from "../../_components/AdminNavbar/SpaceDialog";

export default function BrowseSpacesPage() {
  const { spacesData } = useSharedContext();
  const [searchQuery, setSearchQuery] = useState("");
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);
  const filteredSpaces = spacesData?.filter((space: Space) =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const router = useRouter();
  return (
    <div>
      <div className="flex flex-wrap gap-3 justify-between items-center mb-4 w-full">
        <Button
          onClick={() => setShowSpaceDialog(true)}
          size="sm"
          variant="primary"
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
            className="pr-3 pl-8 w-full text-sm placeholder-gray-8"
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
                  Loading spaces…
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
              filteredSpaces.map((space: Space) => (
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
                    {space.videoCount} video{space.videoCount === 1 ? "" : "s"}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-12">
                    {space.role}
                  </td>
                </tr>
              ))}
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
