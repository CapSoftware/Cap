"use client";

import {
  Command,
  CommandGroup,
  CommandItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cap/ui";
import { MoreVertical, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  useSharedContext,
  useTheme,
} from "@/app/dashboard/_components/DynamicSharedLayout";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { MembersDialog } from "@/app/dashboard/shared-caps/components/MembersDialog";
import { UpgradeModal } from "@/components/UpgradeModal";
import {
  faCrown,
  faDownload,
  faGear,
  faHome,
  faMessage,
  faMoon,
  faSignOut,
  faSun,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function DashboardInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { activeOrganization } = useSharedContext();
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);

  const titles: Record<string, string> = {
    "/dashboard/caps": "Caps",
    "/dashboard/shared-caps": "Shared Caps",
    "/dashboard/settings/organization": "Organization Settings",
    "/dashboard/settings/account": "Account Settings",
    "/dashboard/spaces": "Spaces",
  };
  const title = titles[pathname] || "";
  const { theme, setThemeHandler } = useTheme();
  const isSharedCapsPage = pathname === "/dashboard/shared-caps";

  return (
    <div className="flex flex-col pt-5 min-h-screen lg:gap-5">
      <div
        className={clsx(
          "flex sticky z-50 justify-between items-center px-5 mt-10 w-full h-16 border-b bg-gray-1 lg:bg-transparent border-gray-3 lg:border-b-0 lg:pl-0 lg:pr-5 lg:top-0 lg:relative top-[64px] lg:mt-0 lg:h-8"
        )}
      >
        <div className="flex items-center gap-2">
          <p className="relative text-xl text-gray-12 lg:text-2xl">{title}</p>
          {isSharedCapsPage && activeOrganization?.members && (
            <MembersCount
              count={activeOrganization.members.length}
              onClick={() => setMembersDialogOpen(true)}
            />
          )}
        </div>
        <div className="flex gap-4 items-center">
          <div
            onClick={() => {
              setThemeHandler(theme === "light" ? "dark" : "light");
            }}
            className="hidden justify-center items-center rounded-full border transition-colors cursor-pointer lg:flex bg-gray-4 hover:border-gray-6 hover:bg-gray-5 size-9 border-gray-5"
          >
            <FontAwesomeIcon
              className="text-gray-12 size-3.5"
              icon={theme === "dark" ? faMoon : faSun}
            />
          </div>
          <User />
        </div>
      </div>
      <div
        className={clsx(
          "flex overflow-auto flex-col flex-1 p-5 pb-5 border bg-gray-1 border-gray-3 lg:rounded-tl-2xl lg:p-8"
        )}
      >
        <div className="flex flex-col flex-1 gap-4 h-full">{children}</div>
      </div>

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

const MembersCount = ({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) => {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 rounded-full bg-gray-4 hover:bg-gray-5 text-gray-11 transition-colors"
    >
      <span className="text-gray-11 text-sm">
        {count} {count === 1 ? "member" : "members"}
      </span>
    </button>
  );
};

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
          <div className="flex gap-2 justify-between items-center p-2 rounded-lg transition-colors cursor-pointer group lg:gap-6 hover:bg-gray-5">
            <div className="flex items-center">
              <Avatar
                letterClass="text-xs lg:text-md"
                name={user.name ?? "User"}
                className="size-[24px] text-gray-12"
              />
              <span className="ml-2 text-sm lg:ml-3 lg:text-md text-gray-12">
                {user.name ?? "User"}
              </span>
            </div>
            <MoreVertical className="w-5 h-5 transition-colors text-gray-10 group-hover:text-gray-12" />
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
              {!isSubscribed && (
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
