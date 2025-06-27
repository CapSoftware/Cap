"use client";
import { NewOrganization } from "@/components/forms/NewOrganization";
import { Tooltip } from "@/components/Tooltip";
import { UsageButton } from "@/components/UsageButton";
import { buildEnv } from "@cap/env";
import {
  Avatar,
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cap/ui";
import { classNames } from "@cap/utils";
import { faBuilding } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, ChevronDown, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cloneElement, useRef, useState } from "react";
import { useDashboardContext } from "../../Contexts";
import { CapIcon } from "../AnimatedIcons/Cap";
import { CogIcon, CogIconHandle } from "../AnimatedIcons/Cog";
import { updateActiveOrganization } from "./server";
import SpacesList from "./SpacesList";


interface Props {
  toggleMobileNav?: () => void;
}

export const navItemClass =
  "flex items-center justify-start rounded-xl outline-none tracking-tight overflow-hidden";

const AdminNavItems = ({ toggleMobileNav }: Props) => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const { user, sidebarCollapsed } = useDashboardContext();


  const manageNavigation = [
    {
      name: "My Caps",
      href: `/dashboard/caps`,
      icon: <CapIcon />,
      subNav: [],
    },
    {
      name: "Organization Settings",
      href: `/dashboard/settings/organization`,
      ownerOnly: true,
      icon: <CogIcon />,
      subNav: [],
    },
    ...(buildEnv.NEXT_PUBLIC_IS_CAP && user.email.endsWith("@cap.so")
      ? [
        {
          name: "Admin Dev",
          href: "/dashboard/admin",
          icon: <CogIcon />,
          subNav: [],
        },
      ]
      : []),
  ]

  const [dialogOpen, setDialogOpen] = useState(false);
  const {
    organizationData: orgData,
    activeOrganization: activeOrg,
    isSubscribed: userIsSubscribed,
  } = useDashboardContext();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const isOwner = activeOrg?.organization.ownerId === user.id;

  const isPathActive = (path: string) => pathname.includes(path);

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip
          disable={open || sidebarCollapsed === false}
          position="right"
          content={activeOrg?.organization.name ?? "No organization found"}
        >
          <PopoverTrigger asChild>
            <motion.div
              transition={{
                type: "easeInOut",
                duration: 0.2,
              }}
              className={clsx(
                "mt-1.5 mx-auto p-2.5 rounded-xl cursor-pointer bg-gray-3",
                sidebarCollapsed ? "w-fit" : "w-full"
              )}
            >
              <div
                className={clsx(
                  "flex items-center cursor-pointer",
                  sidebarCollapsed ? "justify-center" : "justify-between"
                )}
                role="combobox"
                aria-expanded={open}
              >
                <div
                  className={clsx(
                    "flex items-center",
                    sidebarCollapsed
                      ? "justify-center w-fit"
                      : "justify-between w-full"
                  )}
                >
                  <div className="flex items-center">
                    {activeOrg?.organization.iconUrl ? (
                      <div className="overflow-hidden relative flex-shrink-0 rounded-full size-[18px]">
                        <Image
                          src={activeOrg.organization.iconUrl}
                          alt={
                            activeOrg.organization.name || "Organization icon"
                          }
                          fill
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <Avatar
                        letterClass={clsx(
                          sidebarCollapsed ? "text-sm" : "text-[11px]"
                        )}
                        className={clsx(
                          "relative flex-shrink-0 mx-auto",
                          sidebarCollapsed ? "size-6" : "size-5"
                        )}
                        name={
                          activeOrg?.organization.name ??
                          "No organization found"
                        }
                      />
                    )}
                    {!sidebarCollapsed && (
                      <p className="ml-2.5 text-sm text-gray-12 truncate">
                        {activeOrg?.organization.name ??
                          "No organization found"}
                      </p>
                    )}
                  </div>
                  {!sidebarCollapsed && (
                    <ChevronDown
                      data-state={open ? "open" : "closed"}
                      className="w-5 h-auto transition-transform duration-200 text-gray-8 data-[state=open]:rotate-180"
                    />
                  )}
                </div>
              </div>
              <PopoverContent
                className={clsx(
                  "p-0 w-full min-w-[287px] md:min-w-fit z-[120]",
                  sidebarCollapsed ? "ml-3" : "mx-auto"
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
                            "rounded-lg transition-colors duration-300 group",
                            isSelected
                              ? "pointer-events-none"
                              : "text-gray-10 hover:text-gray-12 hover:bg-gray-6"
                          )}
                          key={organization.organization.name + "-organization"}
                          onSelect={async () => {
                            await updateActiveOrganization(
                              organization.organization.id
                            );
                            setOpen(false);
                          }}
                        >
                          <div className="flex gap-2 items-center w-full">
                            {organization.organization.iconUrl ? (
                              <div className="overflow-hidden relative flex-shrink-0 rounded-full size-5">
                                <Image
                                  src={organization.organization.iconUrl}
                                  alt={
                                    organization.organization.name ||
                                    "Organization icon"
                                  }
                                  fill
                                  className="object-cover"
                                />
                              </div>
                            ) : (
                              <Avatar
                                letterClass="text-xs"
                                className="relative flex-shrink-0 size-5"
                                name={organization.organization.name}
                              />
                            )}
                            <p
                              className={clsx(
                                "flex-1 text-sm transition-colors duration-200 group-hover:text-gray-12",
                                isSelected ? "text-gray-12" : "text-gray-10"
                              )}
                            >
                              {organization.organization.name}
                            </p>
                          </div>
                          {isSelected && (
                            <Check
                              size={18}
                              className={"ml-auto text-gray-12"}
                            />
                          )}
                        </CommandItem>
                      );
                    })}
                    <DialogTrigger asChild>
                      <Button
                        variant="dark"
                        size="sm"
                        className="flex gap-1 items-center my-2 w-[90%] mx-auto text-sm"
                      >
                        <Plus className="w-3.5 h-auto" />
                        New organization
                      </Button>
                    </DialogTrigger>
                  </CommandGroup>
                </Command>
              </PopoverContent>
            </motion.div>
          </PopoverTrigger>
        </Tooltip>
      </Popover>
      <nav
        className="flex flex-col justify-between w-full h-full"
        aria-label="Sidebar"
      >
        <div
          className={clsx(
            "mt-5",
            sidebarCollapsed ? "flex flex-col justify-center items-center" : ""
          )}
        >
          {manageNavigation.filter((item) => !item.ownerOnly || isOwner).map((item) => (
            <div
              key={item.name}
              className="flex relative justify-center items-center mb-1.5 w-full"
            >
              {isPathActive(item.href) && (
                <motion.div
                  animate={{
                    width: sidebarCollapsed ? 36 : "100%",
                  }}
                  transition={{
                    layout: {
                      type: "tween",
                      duration: 0.15,
                    },
                    width: {
                      type: "tween",
                      duration: 0.05,
                    },
                  }}
                  layoutId="navlinks"
                  id="navlinks"
                  className="absolute h-[36px] w-full rounded-xl pointer-events-none bg-gray-3"
                />
              )}

              {hoveredItem === item.name && !isPathActive(item.href) && (
                <motion.div
                  layoutId="hoverIndicator"
                  className={clsx(
                    "absolute bg-transparent rounded-xl",
                    sidebarCollapsed ? "inset-0 mx-auto w-9 h-9" : "inset-0"
                  )}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    type: "spring",
                    bounce: 0.2,
                    duration: 0.2,
                  }}
                />
              )}
              <NavItem
                name={item.name}
                href={item.href}
                icon={item.icon}
                sidebarCollapsed={sidebarCollapsed}
                toggleMobileNav={toggleMobileNav}
                isPathActive={isPathActive}
              />
            </div>
          ))}

          <SpacesList toggleMobileNav={() => toggleMobileNav?.()} />
        </div>
        <div className="pb-4 mt-auto w-full">
          <UsageButton
            toggleMobileNav={() => toggleMobileNav?.()}
            subscribed={userIsSubscribed}
          />
          <p className="mt-4 text-xs text-center truncate text-gray-10">
            Cap Software, Inc. {new Date().getFullYear()}.
          </p>
        </div>
      </nav>
      <DialogContent className="p-0 w-full max-w-md rounded-xl bg-gray-2">
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
            {createLoading ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};


const NavItem = ({
  name,
  href,
  icon,
  sidebarCollapsed,
  toggleMobileNav,
  isPathActive,
}: {
  name: string;
  href: string;
  icon: React.ReactElement;
  sidebarCollapsed: boolean;
  toggleMobileNav?: () => void;
  isPathActive: (path: string) => boolean;
}) => {
  const iconRef = useRef<CogIconHandle>(null);
  return (
    <Tooltip disable={!sidebarCollapsed} content={name} position="right">
      <Link
        href={href}
        onClick={() => toggleMobileNav?.()}
        onMouseEnter={() => {
          iconRef.current?.startAnimation();
        }}
        onMouseLeave={() => {
          iconRef.current?.stopAnimation();
        }}
        prefetch={false}
        passHref
        className={classNames(
          "relative border border-transparent transition z-3",
          sidebarCollapsed
            ? "flex justify-center items-center px-0 w-full size-9"
            : "px-3 py-2 w-full",
          isPathActive(href)
            ? "bg-transparent pointer-events-none"
            : "hover:bg-gray-2",
          navItemClass
        )}
      >
        {cloneElement(icon, {
          ref: iconRef,
          className: clsx(sidebarCollapsed ? "text-gray-12 mx-auto" : "text-gray-10"),
          size: sidebarCollapsed ? 18 : 16,
        })}
        <p
          className={clsx(
            "text-sm text-gray-12 truncate",
            sidebarCollapsed ? "hidden" : "ml-2.5"
          )}
        >
          {name}
        </p>
      </Link>
    </Tooltip>
  )
}


export default AdminNavItems;
