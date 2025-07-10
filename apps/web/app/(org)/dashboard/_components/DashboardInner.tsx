"use client";

import { UpgradeModal } from "@/components/UpgradeModal";
import { buildEnv } from "@cap/env";
import {
  Avatar,
  Command,
  CommandGroup,
  CommandItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cap/ui";
import { faMoon, faSun } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { MoreVertical } from "lucide-react";
import { signOut } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import React, { cloneElement, memo, useMemo, useRef, useState } from "react";
import { useDashboardContext, useTheme } from "../Contexts";
import { MembersDialog } from "../spaces/[spaceId]/components/MembersDialog";
import {
  ArrowUpIcon,
  MessageCircleMoreIcon,
  DownloadIcon,
  HomeIcon,
  LogoutIcon,
  SettingsGearIcon,
  ReferIcon,
} from "./AnimatedIcons";
import { DownloadIconHandle } from "./AnimatedIcons/Download";
import { ReferIconHandle } from "./AnimatedIcons/Refer";

export const navItemClass =
  "flex items-center justify-start rounded-xl outline-none tracking-tight overflow-hidden";

export default function DashboardInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { activeOrganization, activeSpace } = useDashboardContext();
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
          "flex sticky z-40 justify-between items-center px-5 mt-10 w-full border-b",
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
            <p className="relative text-lg truncate text-gray-12 lg:text-2xl">
              {title}
            </p>
          </div>
        </div>
        <div className="flex gap-4 items-center">
          {buildEnv.NEXT_PUBLIC_IS_CAP && <ReferButton />}
          <div
            onClick={() => {
              if (document.startViewTransition) {
                document.startViewTransition(() => {
                  setThemeHandler(theme === "light" ? "dark" : "light");
                });
              } else {
                setThemeHandler(theme === "light" ? "dark" : "light");
              }
            }}
            className="hidden justify-center items-center rounded-full transition-colors cursor-pointer bg-gray-3 lg:flex hover:bg-gray-5 size-9"
          >
            <FontAwesomeIcon
              className="text-gray-12 size-3.5 view-transition-theme-icon"
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
  const { user, isSubscribed } = useDashboardContext();

  const menuItems = useMemo(
    () => [
      {
        name: "Homepage",
        icon: <HomeIcon />,
        href: "/home",
        onClick: () => setMenuOpen(false),
        iconClassName: "text-gray-11 group-hover:text-gray-12",
        showCondition: true,
      },
      {
        name: "Upgrade to Pro",
        icon: <ArrowUpIcon />,
        onClick: () => {
          setMenuOpen(false);
          setUpgradeModalOpen(true);
        },
        iconClassName: "text-amber-400 group-hover:text-amber-500",
        showCondition: !isSubscribed && buildEnv.NEXT_PUBLIC_IS_CAP,
      },
      {
        name: "Earn 40% Referral",
        icon: <ReferIcon />,
        href: "/dashboard/refer",
        onClick: () => setMenuOpen(false),
        iconClassName: "text-gray-11 group-hover:text-gray-12",
        showCondition: buildEnv.NEXT_PUBLIC_IS_CAP,
      },
      {
        name: "Settings",
        icon: <SettingsGearIcon />,
        href: "/dashboard/settings/account",
        onClick: () => setMenuOpen(false),
        iconClassName: "text-gray-11 group-hover:text-gray-12",
        showCondition: true,
      },
      {
        name: "Chat Support",
        icon: <MessageCircleMoreIcon />,
        onClick: () => window.open("https://cap.link/discord", "_blank"),
        iconClassName: "text-gray-11 group-hover:text-gray-12",
        showCondition: true,
      },
      {
        name: "Download App",
        icon: <DownloadIcon />,
        onClick: () => window.open("https://cap.so/download", "_blank"),
        iconClassName: "text-gray-11 group-hover:text-gray-12",
        showCondition: true,
      },
      {
        name: "Sign Out",
        icon: <LogoutIcon />,
        onClick: () => signOut(),
        iconClassName: "text-gray-11 group-hover:text-gray-12",
        showCondition: true,
      },
    ],
    []
  );

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
              {user.image ? (
                <Image
                  src={user.image}
                  alt={user.name ?? "User"}
                  width={24}
                  height={24}
                  className="rounded-full"
                />
              ) : (
                <Avatar
                  letterClass="text-xs lg:text-md"
                  name={user.name ?? "User"}
                  className="size-[24px] text-gray-12"
                />
              )}
              <span className="ml-2 text-sm truncate lg:ml-2 lg:text-md text-gray-12">
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
              {menuItems
                .filter((item) => item.showCondition)
                .map((item, index) => (
                  <MenuItem
                    key={index}
                    icon={item.icon}
                    name={item.name}
                    href={item.href ?? "#"}
                    onClick={item.onClick}
                    iconClassName={item.iconClassName}
                  />
                ))}
            </CommandGroup>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
};

interface Props {
  icon: React.ReactElement;
  name: string;
  href?: string;
  onClick: () => void;
  iconClassName?: string;
}

const MenuItem = memo(({ icon, name, href, onClick, iconClassName }: Props) => {
  const iconRef = useRef<DownloadIconHandle>(null);
  return (
    <CommandItem
      key={name}
      className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-5 group"
      onSelect={onClick}
      onMouseEnter={() => {
        iconRef.current?.startAnimation();
      }}
      onMouseLeave={() => {
        iconRef.current?.stopAnimation();
      }}
    >
      <Link
        className="flex gap-2 items-center w-full"
        href={href ?? "#"}
        onClick={onClick}
      >
        <div className="flex-shrink-0 flex items-center justify-center w-3.5 h-3.5">
          {cloneElement(icon, {
            ref: iconRef,
            className: iconClassName,
            size: 14,
          })}
        </div>
        <p className={clsx("text-sm text-gray-12")}>{name}</p>
      </Link>
    </CommandItem>
  );
});

const ReferButton = () => {
  const iconRef = useRef<ReferIconHandle>(null);

  return (
    <Link href="/dashboard/refer" className="hidden relative lg:block">
      {/* Red notification dot with pulse animation */}
      <div className="absolute right-0 top-1 z-10">
        <div className="relative">
          <div className="absolute inset-0 w-2 h-2 bg-red-500 rounded-full opacity-75 animate-ping" />
          <div className="relative w-2 h-2 bg-red-500 rounded-full" />
        </div>
      </div>

      <div
        onMouseEnter={() => {
          iconRef.current?.startAnimation();
        }}
        onMouseLeave={() => {
          iconRef.current?.stopAnimation();
        }}
        className="flex justify-center items-center rounded-full transition-colors cursor-pointer bg-gray-3 hover:bg-gray-5 size-9"
      >
        {cloneElement(<ReferIcon />, {
          ref: iconRef,
          className: "text-gray-12 size-3.5",
        })}
      </div>
    </Link>
  );
};
