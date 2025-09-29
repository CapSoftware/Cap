"use client";
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
import {
	faBuilding,
	faCircleInfo,
	faLink,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cloneElement, type RefObject, useRef, useState } from "react";
import { NewOrganization } from "@/components/forms/NewOrganization";
import { Tooltip } from "@/components/Tooltip";
import { UsageButton } from "@/components/UsageButton";
import { useDashboardContext } from "../../Contexts";
import { CapIcon, CogIcon } from "../AnimatedIcons";
import type { CogIconHandle } from "../AnimatedIcons/Cog";
import CapAIBox from "./CapAIBox";
import SpacesList from "./SpacesList";
import { updateActiveOrganization } from "./server";

interface Props {
	toggleMobileNav?: () => void;
}

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
	];

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
	const [openAIDialog, setOpenAIDialog] = useState(false);
	const router = useRouter();

	const isPathActive = (path: string) => pathname.includes(path);
	const isDomainSetupVerified =
		activeOrg?.organization.customDomain &&
		activeOrg?.organization.domainVerified;

	return (
		<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
			<Popover open={open} onOpenChange={setOpen}>
				<Tooltip
					disable={open || sidebarCollapsed === false}
					position="right"
					content={activeOrg?.organization.name ?? "No organization found"}
				>
					<PopoverTrigger suppressHydrationWarning asChild>
						<motion.div
							transition={{
								type: "easeInOut",
								duration: 0.2,
							}}
							className={clsx(
								"mt-1.5 mx-auto rounded-xl cursor-pointer bg-gray-3",
								sidebarCollapsed ? "w-fit px-2 py-0.5" : "w-full p-2.5",
							)}
						>
							<div
								className={clsx(
									"flex flex-col items-center cursor-pointer",
									sidebarCollapsed ? "justify-center" : "justify-between",
								)}
								role="combobox"
								aria-expanded={open}
							>
								<div
									className={clsx(
										"flex items-center",
										sidebarCollapsed
											? "justify-center w-fit"
											: "justify-between gap-2.5 w-full",
									)}
								>
									<div className="flex items-center">
										{activeOrg?.organization.iconUrl ? (
											<div
												className={clsx(
													"overflow-hidden relative flex-shrink-0 rounded-full",
													sidebarCollapsed ? "size-6" : "size-7",
												)}
											>
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
													sidebarCollapsed ? "text-sm" : "text-[13px]",
												)}
												className={clsx(
													"relative flex-shrink-0 mx-auto",
													sidebarCollapsed ? "size-6" : "size-7",
												)}
												name={
													activeOrg?.organization.name ??
													"No organization found"
												}
											/>
										)}
									</div>
									<div className="flex flex-col flex-1 items-center h-10">
										<div className="flex justify-between items-center w-full">
											{!sidebarCollapsed && (
												<p className="text-sm truncate leading-0 text-gray-12">
													{activeOrg?.organization.name ??
														"No organization found"}
												</p>
											)}
											{!sidebarCollapsed && (
												<ChevronDown
													data-state={open ? "open" : "closed"}
													className="size-4 transition-transform duration-200 text-gray-10 data-[state=open]:rotate-180"
												/>
											)}
										</div>
										{!sidebarCollapsed && (
											<Link
												href={
													isDomainSetupVerified
														? `https://${activeOrg.organization.customDomain}`
														: "/dashboard/settings/organization"
												}
												rel={
													isDomainSetupVerified
														? "noopener noreferrer"
														: undefined
												}
												target={isDomainSetupVerified ? "_blank" : "_self"}
												className="flex truncate w-full overflow-hidden flex-1 gap-1.5 items-center self-start"
											>
												<FontAwesomeIcon
													icon={isDomainSetupVerified ? faLink : faCircleInfo}
													className="duration-200 size-3 text-gray-10"
												/>
												<p className="w-full text-[11px] flex-1 duration-200 truncate leading-0 text-gray-11">
													{isDomainSetupVerified
														? activeOrg?.organization.customDomain
														: "No custom domain set"}
												</p>
											</Link>
										)}
									</div>
								</div>
							</div>
							<PopoverContent
								className={clsx(
									"p-0 w-full min-w-[287px] md:min-w-fit z-[120]",
									sidebarCollapsed ? "ml-3" : "mx-auto",
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
															: "text-gray-10 hover:text-gray-12 hover:bg-gray-6",
													)}
													key={`${organization.organization.name}-organization`}
													onSelect={async () => {
														await updateActiveOrganization(
															organization.organization.id,
														);
														setOpen(false);
														router.push("/dashboard/caps");
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
																isSelected ? "text-gray-12" : "text-gray-10",
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
						sidebarCollapsed ? "flex flex-col justify-center items-center" : "",
					)}
				>
					{manageNavigation
						.filter((item) => !item.ownerOnly || isOwner)
						.map((item) => (
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
											sidebarCollapsed ? "inset-0 mx-auto w-9 h-9" : "inset-0",
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
					<AnimatePresence>
						{!sidebarCollapsed && (
							<motion.div
								initial={{ scale: 0 }}
								animate={{ scale: 1 }}
								exit={{ scale: 0 }}
								transition={{
									type: "spring",
									bounce: 0.2,
									duration: 0.2,
								}}
							>
								<CapAIBox
									openAIDialog={openAIDialog}
									setOpenAIDialog={setOpenAIDialog}
								/>
							</motion.div>
						)}
					</AnimatePresence>
					<UsageButton
						toggleMobileNav={() => toggleMobileNav?.()}
						subscribed={userIsSubscribed}
					/>
					{buildEnv.NEXT_PUBLIC_IS_CAP && (
						<div className="flex justify-center items-center mt-2">
							<Link
								href="/dashboard/refer"
								className="text-sm underline text-gray-10 hover:text-gray-12"
							>
								Earn 40% Referral
							</Link>
						</div>
					)}
					<p className="mt-2 text-xs text-center truncate text-gray-10">
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
	icon: React.ReactElement<{
		ref: RefObject<CogIconHandle | null>;
		className: string;
		size: number;
	}>;
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
					"flex overflow-hidden justify-start items-center tracking-tight rounded-xl outline-none",
				)}
			>
				{cloneElement(icon, {
					ref: iconRef,
					className: clsx(
						sidebarCollapsed ? "text-gray-12 mx-auto" : "text-gray-10",
					),
					size: sidebarCollapsed ? 18 : 16,
				})}
				<p
					className={clsx(
						"text-sm text-gray-12 truncate",
						sidebarCollapsed ? "hidden" : "ml-2.5",
					)}
				>
					{name}
				</p>
			</Link>
		</Tooltip>
	);
};

export default AdminNavItems;
