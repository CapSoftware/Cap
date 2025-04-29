"use client";
import { Button } from "@cap/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
} from "@cap/ui";
import { NewSpace } from "@/components/forms/NewSpace";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { EmptySpaceState } from "./components/EmptySpaceState";
import { CapPagination } from "../caps/components/CapPagination";
import { updateActiveSpace } from "../_components/AdminNavbar/server";

type SpaceData = {
  id: string;
  name: string;
  members: number;
  videos: number;
  role: string;
}[];

export const Spaces = ({
  data,
  count,
  user,
}: {
  data: SpaceData;
  count: number;
  user: any;
}) => {
  const router = useRouter();
  const { refresh } = router;
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const limit = 15;
  const totalPages = Math.ceil(count / limit);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  if (data.length === 0) {
    return <EmptySpaceState />;
  }

  const filteredData = searchTerm
    ? data.filter((space) =>
        space.name.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : data;

  return (
    <div className="flex relative flex-col w-full">
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 sm:gap-0 mb-6">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-11" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search spaces..."
              className="pl-8 h-9"
            />
          </div>
          <DialogTrigger asChild>
            <Button
              variant="primary"
              size="sm"
              className="flex gap-1 items-center w-full justify-center sm:w-auto"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="w-4 h-auto" />
              New Space
            </Button>
          </DialogTrigger>
        </div>

        <div className="overflow-hidden rounded-xl border shadow-sm border-gray-4 bg-gray-2">
          {/* Table view (hidden on mobile) */}
          <table className="w-full hidden sm:table">
            <thead>
              <tr className="border-b border-gray-4 bg-gray-3">
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-11">
                  Name
                </th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-11">
                  Members
                </th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-11">
                  Videos
                </th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-11">
                  Role
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredData.length > 0 ? (
                filteredData.map((space) => (
                  <tr
                    key={space.id}
                    className="border-b border-gray-4 last:border-0 hover:bg-gray-3 cursor-pointer transition-colors"
                    onClick={async () => {
                      await updateActiveSpace(space.id);
                      refresh();
                      router.push("/dashboard/shared-caps");
                    }}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <Avatar
                          letterClass="text-gray-1 text-xs"
                          className="relative flex-shrink-0 size-9"
                          name={space.name}
                        />
                        <span className="text-sm font-medium text-gray-12">
                          {space.name}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-11">
                      {space.members}{" "}
                      {space.members === 1 ? "member" : "members"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-11">
                      {space.videos} {space.videos === 1 ? "video" : "videos"}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`text-sm font-medium ${
                          space.role === "Owner"
                            ? "text-blue-600"
                            : "text-gray-11"
                        }`}
                      >
                        {space.role}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-gray-11">
                    No spaces found matching your search
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Card view (shown only on mobile) */}
          <div className="sm:hidden">
            {filteredData.length > 0 ? (
              filteredData.map((space) => (
                <div
                  key={space.id}
                  className="border-b border-gray-4 last:border-0 p-4 hover:bg-gray-3 cursor-pointer transition-colors"
                  onClick={async () => {
                    await updateActiveSpace(space.id);
                    refresh();
                    router.push("/dashboard/shared-caps");
                  }}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <Avatar
                      letterClass="text-gray-1 text-xs"
                      className="relative flex-shrink-0 size-10"
                      name={space.name}
                    />
                    <span className="text-sm font-medium text-gray-12">
                      {space.name}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 ml-1 mt-3">
                    <div>
                      <p className="text-xs text-gray-10">Members</p>
                      <p className="text-sm text-gray-11">
                        {space.members}{" "}
                        {space.members === 1 ? "member" : "members"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-10">Videos</p>
                      <p className="text-sm text-gray-11">
                        {space.videos} {space.videos === 1 ? "video" : "videos"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-10">Role</p>
                      <p
                        className={`text-sm font-medium ${
                          space.role === "Owner"
                            ? "text-blue-600"
                            : "text-gray-11"
                        }`}
                      >
                        {space.role}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-gray-11">
                No spaces found matching your search
              </div>
            )}
          </div>
        </div>

        {(data.length > limit || data.length === limit || page !== 1) && (
          <div className="mt-6 sm:mt-10">
            <CapPagination currentPage={page} totalPages={totalPages} />
          </div>
        )}

        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new Space</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <NewSpace
              onSpaceCreated={() => {
                setDialogOpen(false);
                refresh();
              }}
            />
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </div>
  );
};
