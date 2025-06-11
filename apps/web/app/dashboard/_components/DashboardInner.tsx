"use client";

import {
  useSharedContext,
  useTheme,
} from "@/app/dashboard/_components/DynamicSharedLayout";
import { UpgradeModal } from "@/components/UpgradeModal";
import { buildEnv } from "@cap/env";
import {
  Command,
  CommandGroup,
  CommandItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Avatar,
} from "@cap/ui";
import { MembersDialog } from "@/app/dashboard/spaces/[spaceId]/components/MembersDialog";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { MoreVertical } from "lucide-react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  faMoon,
  faSun,
  faHome,
  faCrown,
  faGear,
  faMessage,
  faSignOut,
  faDownload,
} from "@fortawesome/free-solid-svg-icons";
import Image from "next/image";

export default function DashboardInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { activeOrganization, activeSpace } = useSharedContext();
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);

  const titles: Record<string, string> = {
    "/dashboard/caps": "Caps",
    "/dashboard/shared-caps": "Shared Caps",
    "/dashboard/settings/organization": "Organization Settings",
    "/dashboard/settings/account": "Account Settings",
    "/dashboard/spaces": "Spaces",
    "/dashboard/spaces/browse": "Browse Spaces",
  };

  const title = activeSpace ? activeSpace.name : titles[pathname] || "";
  const { theme, setThemeHandler } = useTheme();
  const isSharedCapsPage = pathname === "/dashboard/shared-caps";

  return (
    <div className="flex flex-col min-h-screen">
      <div
        className={clsx(
          "flex sticky z-50 justify-between items-center px-5 mt-10 w-full border-b",
          "bg-gray-1 lg:bg-transparent min-h-16 lg:min-h-10 border-gray-3 lg:border-b-0 lg:pl-0 lg:pr-5 lg:top-0 lg:relative top-[64px] lg:mt-5 lg:h-8"
        )}
      >
        <div className="flex flex-col gap-0.5">
          {activeSpace && <span className="text-xs text-gray-11">Space</span>}
          <div className="flex gap-1.5 items-center">
            {activeSpace &&
              (activeSpace.iconUrl ? (
                <Image
                  src={activeSpace?.iconUrl}
                  alt={activeSpace?.name || "Space"}
                  width={20}
                  height={20}
                  className="rounded-full"
                />
              ) : (
                <Avatar
                  letterClass="text-xs"
                  className="relative flex-shrink-0 size-5"
                  name={activeSpace?.name}
                />
              ))}
            <p className="relative text-base truncate md:text-lg text-gray-12 lg:text-2xl">
              {title}
            </p>
          </div>
        </div>
        <div className="flex gap-4 items-center">
          <div
            onClick={() => {
              setThemeHandler(theme === "light" ? "dark" : "light");
            }}
            className="hidden justify-center items-center rounded-full transition-colors cursor-pointer bg-gray-3 lg:flex hover:bg-gray-5 size-9"
          >
            <FontAwesomeIcon
              className="text-gray-12 size-3.5"
              icon={theme === "dark" ? faMoon : faSun}
            />
          </div>
          <User />
        </div>
      </div>
      <main
        className={
          "flex flex-col flex-1 p-5 pb-5 mt-5 border border-b-0 min-h-fit bg-gray-2 border-gray-3 lg:rounded-tl-2xl lg:p-8"
        }
      >
        <div className="flex flex-col flex-1 gap-4">{children}</div>
      </main>
      {isSharedCapsPage && activeOrganization?.members && (
        <MembersDialog
          open={membersDialogOpen}
          onOpenChange={setMembersDialogOpen}
          members={activeOrganization.members}
          organizationName={activeOrganization.organization.name || ""}
        />
      )}
    </div>
  );
}

const User = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const { user, isSubscribed } = useSharedContext();
  return (
    <>
      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <div
            data-state={menuOpen ? "open" : "closed"}
            className="flex gap-2 justify-between  items-center p-2 rounded-xl border data-[state=open]:border-gray-3 data-[state=open]:bg-gray-3 border-transparent transition-colors cursor-pointer group lg:gap-6 hover:border-gray-3"
          >
            <div className="flex items-center">
              <Avatar
                letterClass="text-xs lg:text-md"
                name={user.name ?? "User"}
                className="size-[24px] text-gray-12"
              />
              <span className="ml-2 text-sm lg:ml-2 lg:text-md text-gray-12">
                {user.name ?? "User"}
              </span>
            </div>
            <MoreVertical
              data-state={menuOpen ? "open" : "closed"}
              className="w-5 h-5 data-[state=open]:text-gray-12 transition-colors text-gray-10 group-hover:text-gray-12"
            />
          </div>
        </PopoverTrigger>
        <PopoverContent className="p-1 w-48">
          <Command>
            <CommandGroup>
              <Link href="/home">
                <CommandItem
                  className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-5 group"
                  onSelect={() => {
                    setMenuOpen(false);
                  }}
                >
                  <FontAwesomeIcon
                    icon={faHome}
                    className="mr-2 text-gray-11 transition-colors duration-300 size-3.5 group-hover:text-gray-12"
                  />
                  <span className="text-[13px] transition-colors duration-300 text-gray-11 group-hover:text-gray-12">
                    Homepage
                  </span>
                </CommandItem>
              </Link>
              {!isSubscribed && buildEnv.NEXT_PUBLIC_IS_CAP && (
                <CommandItem
                  className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-5 group"
                  onSelect={() => {
                    setMenuOpen(false);
                    setUpgradeModalOpen(true);
                  }}
                >
                  <FontAwesomeIcon
                    icon={faCrown}
                    className="mr-2 text-amber-400 transition-colors duration-300 size-3.5 group-hover:text-amber-500"
                  />
                  <span className="text-[13px] transition-colors duration-300 text-gray-11 group-hover:text-gray-12">
                    Upgrade to Pro
                  </span>
                </CommandItem>
              )}
              <Link href="/dashboard/settings/account">
                <CommandItem
                  className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-5 group"
                  onSelect={() => {
                    setMenuOpen(false);
                  }}
                >
                  <FontAwesomeIcon
                    icon={faGear}
                    className="mr-2 text-gray-11 transition-colors duration-300 size-3.5 group-hover:text-gray-12"
                  />
                  <span className="text-[13px] transition-colors duration-300 text-gray-11 group-hover:text-gray-12">
                    Settings
                  </span>
                </CommandItem>
              </Link>
              <CommandItem
                className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-5 group"
                onSelect={() =>
                  window.open("https://cap.link/discord", "_blank")
                }
              >
                <FontAwesomeIcon
                  icon={faMessage}
                  className="mr-2 text-gray-11 transition-colors duration-300 size-3.5 group-hover:text-gray-12"
                />
                <span className="text-[13px] transition-colors duration-300 text-gray-11 group-hover:text-gray-12">
                  Chat Support
                </span>
              </CommandItem>

              <CommandItem
                className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-5 group"
                onSelect={() =>
                  window.open("https://cap.so/download", "_blank")
                }
              >
                <FontAwesomeIcon
                  icon={faDownload}
                  className="mr-2 text-gray-11 transition-colors duration-300 size-3.5 group-hover:text-gray-12"
                />
                <span className="text-[13px] transition-colors duration-300 text-gray-11 group-hover:text-gray-12">
                  Download App
                </span>
              </CommandItem>

              <CommandItem
                className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-5 group"
                onSelect={() => signOut()}
              >
                <FontAwesomeIcon
                  icon={faSignOut}
                  className="mr-2 text-gray-11 transition-colors duration-300 size-3.5 group-hover:text-gray-12"
                />
                <span className="text-[13px] transition-colors duration-300 text-gray-11 group-hover:text-gray-12">
                  Sign Out
                </span>
              </CommandItem>
            </CommandGroup>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
};
