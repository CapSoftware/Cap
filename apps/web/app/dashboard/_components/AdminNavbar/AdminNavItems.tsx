"use client";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cap/ui";
import { classNames } from "@cap/utils";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { NewOrganization } from "@/components/forms/NewOrganization";
import { Tooltip } from "@/components/Tooltip";
import { UsageButton } from "@/components/UsageButton";
import { buildEnv } from "@cap/env";
import {
  faBuilding,
  faDownload,
  faRecordVinyl,
  IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion } from "framer-motion";

import { updateActiveOrganization, createSpace } from "./server";
import { useRef, useState } from "react";

export const AdminNavItems = ({ collapsed }: { collapsed?: boolean }) => {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const {
    organizationData,
    activeOrganization,
    user,
    isSubscribed,
    spacesData,
  } = useSharedContext();

  const manageNavigation = [
    {
      name: "My Caps",
      href: `/dashboard/caps`,
      icon: faRecordVinyl,
      subNav: [],
    },
    {
      name: "Settings",
      href: `/dashboard/settings/organization`,
      icon: faBuilding,
      subNav: [],
    },
  ];

  const navItemClass = `flex items-center justify-start p-2 rounded-2xl outline-none tracking-tight w-full overflow-hidden ${
    collapsed ? "w-9" : "w-full"
  }`;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [newSpaceDescription, setNewSpaceDescription] = useState("");
  const [isCreatingSpace, setIsCreatingSpace] = useState(false);
  const [spaceError, setSpaceError] = useState<string | null>(null);

  // Filter spaces based on search query
  const filteredSpaces =
    spacesData?.filter(
      (space) =>
        space.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        space.organizationId === activeOrganization?.organization.id
    ) || [];

  const handleCreateSpace = async () => {
    if (!newSpaceName.trim()) {
      setSpaceError("Space name is required");
      return;
    }

    setIsCreatingSpace(true);
    setSpaceError(null);

    try {
      const result = await createSpace(
        newSpaceName.trim(),
        newSpaceDescription.trim() || null
      );

      if (result.success) {
        setSpaceDialogOpen(false);
        setNewSpaceName("");
        setNewSpaceDescription("");
      } else {
        setSpaceError(result.error || "Failed to create space");
      }
    } catch (error) {
      setSpaceError("An unexpected error occurred");
      console.error(error);
    } finally {
      setIsCreatingSpace(false);
    }
  };
  const {
    organizationData: orgData,
    activeOrganization: activeOrg,
    isSubscribed: userIsSubscribed,
  } = useSharedContext();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [organizationName, setOrganizationName] = useState("");

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip
          disable={open || collapsed === false}
          position="right"
          content={activeOrg?.organization.name ?? "No organization found"}
        >
          <PopoverTrigger asChild>
            <div
              className={
                "px-3 py-2.5 w-full rounded-xl border cursor-pointer bg-gray-3 border-gray-4"
              }
            >
              <div
                className="flex justify-between items-center cursor-pointer"
                role="combobox"
                aria-expanded={open}
              >
                <div className="flex justify-between items-center w-full text-left">
                  <div className="flex items-center">
                    <Avatar
                      letterClass="text-gray-1 text-xs"
                      className="relative flex-shrink-0 size-5"
                      name={
                        activeOrg?.organization.name ?? "No organization found"
                      }
                    />
                    <p className="ml-2.5 text-sm text-gray-12 font-medium truncate">
                      {activeOrg?.organization.name ?? "No organization found"}
                    </p>
                  </div>
                  {!collapsed && (
                    <ChevronDown className="w-5 h-auto text-gray-8" />
                  )}
                </div>
              </div>
              <PopoverContent
                className={clsx(
                  "p-0 w-[calc(100%-12px)] z-[60]",
                  collapsed ? "ml-3" : "mx-auto"
                )}
              >
                <Command>
                  <CommandInput placeholder="Search organizations..." />
                  <CommandEmpty>No organizations found</CommandEmpty>
                  <CommandGroup>
                    {orgData?.map((organization) => {
                      const isSelected =
                        activeOrg?.organization.id ===
                        organization.organization.id;
                      return (
                        <CommandItem
                          className={clsx(
                            "transition-colors duration-300",
                            isSelected
                              ? "pointer-events-none text-gray-12"
                              : "!text-gray-10 hover:!text-gray-12"
                          )}
                          key={organization.organization.name + "-organization"}
                          onSelect={async () => {
                            await updateActiveOrganization(
                              organization.organization.id
                            );
                            setOpen(false);
                          }}
                        >
                          {organization.organization.name}
                          {isSelected && (
                            <Check size={18} className={"ml-auto"} />
                          )}
                        </CommandItem>
                      );
                    })}
                    <DialogTrigger className="mt-3 w-full">
                      <Button
                        variant="dark"
                        size="sm"
                        className="flex gap-1 items-center w-full"
                      >
                        <Plus className="w-4 h-auto" />
                        Add new organization
                      </Button>
                    </DialogTrigger>
                  </CommandGroup>
                </Command>
              </PopoverContent>
            </div>
          </PopoverTrigger>
        </Tooltip>
      </Popover>
      <nav
        className="flex flex-col justify-between w-full h-full"
        aria-label="Sidebar"
      >
        <div className={clsx("space-y-2.5", collapsed ? "items-center" : "")}>
          {manageNavigation.map((item) => (
            <div key={item.name} className="flex relative justify-center">
              {pathname.includes(item.href) ? (
                <motion.div
                  initial={{
                    width: collapsed ? 40 : "100%",
                    height: collapsed ? 40 : "100%",
                  }}
                  animate={{
                    width: collapsed ? 40 : "100%",
                    height: collapsed ? 40 : "100%",
                  }}
                  transition={{
                    type: "spring",
                    bounce: 0.2,
                    duration: 0.4,
                    width: { type: "tween", duration: 0.05 },
                  }}
                  layoutId="underline"
                  id="underline"
                  className={clsx(
                    "absolute inset-0 mx-auto rounded-xl shadow-sm border-gray-5 text-gray-8 border-[1px] shadow-gray-2"
                  )}
                />
              ) : null}
              <Tooltip
                content={item.name}
                disable={collapsed === false}
                position="right"
              >
                <Link
                  passHref
                  prefetch={false}
                  href={item.href}
                  className={classNames(
                    "relative transition-opacity duration-200 hover:opacity-75 z-3",
                    navItemClass
                  )}
                >
                  <FontAwesomeIcon
                    icon={item.icon as IconDefinition}
                    className={classNames(
                      "flex-shrink-0 w-5 h-5 transition-colors duration-200 stroke-[1.5px]",
                      collapsed ? "text-gray-12" : "text-gray-10"
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-base ml-2.5 text-gray-12 truncate">
                    {item.name}
                  </span>
                </Link>
              </Tooltip>
            </div>
          ))}

          {/* Spaces Section */}
          <div className="mt-6 pt-4 border-t border-gray-3">
            <div className="flex justify-between items-center px-3 py-2">
              <h3 className="text-sm text-gray-10 font-medium">Spaces</h3>
              <button
                onClick={() => setSpaceDialogOpen(true)}
                className="text-gray-8 hover:text-gray-12"
              >
                <Plus className="w-5 h-auto" />
              </button>
            </div>

            {/* Search Spaces */}
            <div className="px-3 mt-2">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 text-gray-8 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Search spaces"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-9 pl-9 pr-3 rounded-lg bg-gray-3 border border-gray-4 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-blue-10"
                />
              </div>
            </div>

            {/* All Organization Space */}
            <Tooltip
              content={`All ${
                activeOrganization?.organization.name || "Organization"
              }`}
              disable={collapsed === false}
              position="right"
            >
              <Link
                href={`/dashboard/spaces/${activeOrganization?.organization.id}`}
                className={classNames(
                  "flex gap-2 items-center px-3 py-2 mt-2 rounded-lg",
                  pathname.includes("/dashboard/spaces")
                    ? "bg-gray-4 text-gray-12"
                    : "text-gray-10 hover:text-gray-12 hover:bg-gray-3"
                )}
              >
                <Avatar
                  letterClass="text-gray-1 text-xs"
                  className="relative flex-shrink-0 size-5"
                  name={activeOrganization?.organization.name || "All"}
                />
                <span className="text-sm font-medium truncate">
                  All {activeOrganization?.organization.name || "Organization"}
                </span>
              </Link>
            </Tooltip>

            {/* Space List */}
            {filteredSpaces.map((space) => (
              <Tooltip
                key={space.id}
                content={space.name}
                disable={collapsed === false}
                position="right"
              >
                <Link
                  href={`/dashboard/spaces/${space.id}`}
                  className={classNames(
                    "flex gap-2 items-center px-3 py-2 mt-1 rounded-lg",
                    pathname.includes(`/dashboard/spaces/${space.id}`)
                      ? "bg-gray-4 text-gray-12"
                      : "text-gray-10 hover:text-gray-12 hover:bg-gray-3"
                  )}
                >
                  <Avatar
                    letterClass="text-gray-1 text-xs"
                    className="relative flex-shrink-0 size-5"
                    name={space.name}
                  />
                  <span className="text-sm font-medium truncate">
                    {space.name}
                  </span>
                </Link>
              </Tooltip>
            ))}
          </div>
        </div>
        <div className="pb-0 w-full lg:pb-5 text-center">
          <UsageButton
            collapsed={collapsed ?? false}
            subscribed={userIsSubscribed}
          />
          <Link
            href="/download"
            className="inline-flex mt-3 text-xs text-center truncate font-semibold text-gray-10 hover:text-gray-12 hover:underline"
          >
            Download App
          </Link>
          <p className="mt-1 text-xs text-center truncate text-gray-10">
            Cap Software, Inc. {new Date().getFullYear()}.
          </p>
        </div>
      </nav>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faBuilding} />}
          description="A new organization to share caps with your team"
        >
          <DialogTitle className="text-lg text-gray-12">
            Create New Organization
          </DialogTitle>
        </DialogHeader>
        <div className="p-5">
          <NewOrganization
            setCreateLoading={setCreateLoading}
            onOrganizationCreated={() => setDialogOpen(false)}
            formRef={formRef}
            onNameChange={setOrganizationName}
          />
        </div>
        <DialogFooter>
          <Button variant="gray" size="sm" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="dark"
            size="sm"
            disabled={createLoading || !organizationName.trim().length}
            spinner={createLoading}
            onClick={() => formRef.current?.requestSubmit()}
            type="submit"
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* New Space Dialog */}
      <Dialog open={spaceDialogOpen} onOpenChange={setSpaceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new Space</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <div className="space-y-4 pt-2">
              <div>
                <label
                  htmlFor="spaceName"
                  className="block text-sm font-medium text-gray-12"
                >
                  Space Name
                </label>
                <input
                  type="text"
                  id="spaceName"
                  value={newSpaceName}
                  onChange={(e) => setNewSpaceName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-4 bg-gray-2 px-3 py-2 text-gray-12 focus:border-blue-10 focus:outline-none focus:ring-1 focus:ring-blue-10"
                  placeholder="Enter space name"
                />
              </div>
              <div>
                <label
                  htmlFor="spaceDescription"
                  className="block text-sm font-medium text-gray-12"
                >
                  Description (optional)
                </label>
                <textarea
                  id="spaceDescription"
                  rows={3}
                  value={newSpaceDescription}
                  onChange={(e) => setNewSpaceDescription(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-4 bg-gray-2 px-3 py-2 text-gray-12 focus:border-blue-10 focus:outline-none focus:ring-1 focus:ring-blue-10"
                  placeholder="Describe the purpose of this space"
                />
              </div>
              {spaceError && (
                <p className="text-red-500 text-sm">{spaceError}</p>
              )}
              <div className="pt-2">
                <Button
                  variant="dark"
                  className="w-full"
                  disabled={isCreatingSpace}
                  onClick={handleCreateSpace}
                >
                  {isCreatingSpace ? "Creating..." : "Create Space"}
                </Button>
              </div>
            </div>
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
};

export default AdminNavItems;
