"use client";
import { buildEnv } from "@cap/env";
import {
	Button,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	commandScore,
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
import { faBuilding } from "@fortawesome/free-solid-svg-icons/faBuilding";
import { faCircleInfo } from "@fortawesome/free-solid-svg-icons/faCircleInfo";
import { faLink } from "@fortawesome/free-solid-svg-icons/faLink";
import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, ChevronsUpDown, Gift, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
	cloneElement,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { NewOrganization } from "@/components/forms/NewOrganization";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";
import { UsageButton } from "@/components/UsageButton";
import { canUseInfra } from "@/lib/infra-access";
import { INFRA_BASE_PATH } from "@/lib/infra-routes";
import {
	loomImportDestinationFromPathname,
	loomImportPageHref,
} from "@/lib/loom-import-destination";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";
import {
	canViewOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { useDashboardContext } from "../../Contexts";
import {
	CapIcon,
	ChartLineIcon,
	CodeIcon,
	CogIcon,
	ImportIcon,
	RecordIcon,
} from "../AnimatedIcons";
import type { CogIconHandle } from "../AnimatedIcons/Cog";
import { MemberAvatars } from "./MemberAvatars";
import SpacesList from "./SpacesList";
import { updateActiveOrganization } from "./server";

interface Props {
	toggleMobileNav?: () => void;
}

const AdminNavItems = ({ toggleMobileNav }: Props) => {
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const { user, sidebarCollapsed, userCapsCount } = useDashboardContext();

	const showDeveloperDashboard =
		buildEnv.NEXT_PUBLIC_IS_CAP === "true" && canUseInfra(user.email);
	const showMigrationQueue =
		buildEnv.NEXT_PUBLIC_IS_CAP &&
		user.email.toLowerCase() === MESSENGER_ADMIN_EMAIL;

	const manageNavigation = [
		{
			name: "My Caps",
			href: `/dashboard/caps`,
			extraText: userCapsCount,
			icon: <CapIcon />,
			subNav: [],
		},
		{
			name: "Analytics",
			href: `/dashboard/analytics`,
			matchChildren: true,
			icon: <ChartLineIcon />,
			subNav: [],
		},
		{
			name: "Record a Cap",
			href: `/dashboard/caps/record`,
			icon: <RecordIcon />,
			subNav: [],
		},
		{
			name: "Import Media",
			href: loomImportPageHref(loomImportDestinationFromPathname(pathname)),
			matchChildren: true,
			icon: <ImportIcon />,
			subNav: [],
		},
		{
			name: "Organization Settings",
			href: `/dashboard/settings/organization`,
			adminOnly: true,
			matchChildren: true,
			icon: <CogIcon />,
			subNav: [],
		},
		...(showDeveloperDashboard
			? [
					{
						name: "Infra",
						href: "/dashboard/infra",
						ownerOnly: true,
						matchChildren: true,
						icon: <CodeIcon />,
						subNav: [] as { name: string; href: string }[],
					},
				]
			: []),
		...(showMigrationQueue
			? [
					{
						name: "Migration Queue",
						href: "/dashboard/admin/loom-migrations",
						icon: <ImportIcon />,
						subNav: [],
					},
				]
			: []),
	];

	const [dialogOpen, setDialogOpen] = useState(false);
	const { organizationData: orgData, activeOrganization: activeOrg } =
		useDashboardContext();
	const formRef = useRef<HTMLFormElement | null>(null);
	const [createLoading, setCreateLoading] = useState(false);
	const [organizationName, setOrganizationName] = useState("");
	const organizationSearchText = useMemo(
		() =>
			new Map(
				(orgData ?? []).map(({ organization }) => [
					organization.id.toLowerCase(),
					organization.name.trim().toLowerCase(),
				]),
			),
		[orgData],
	);
	const isOwner = activeOrg?.organization.ownerId === user.id;
	const currentMember = activeOrg?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrg?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const canViewSettings = canViewOrganizationSettings(currentRole);
	const [_openAIDialog, _setOpenAIDialog] = useState(false);
	const router = useRouter();

	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [canScrollUp, setCanScrollUp] = useState(false);
	const [canScrollDown, setCanScrollDown] = useState(false);

	const updateScrollFades = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const maxScroll = el.scrollHeight - el.clientHeight;
		setCanScrollUp(el.scrollTop > 1);
		setCanScrollDown(el.scrollTop < maxScroll - 1);
	}, []);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		updateScrollFades();
		const observer = new ResizeObserver(() => updateScrollFades());
		observer.observe(el);
		if (contentRef.current) observer.observe(contentRef.current);
		return () => observer.disconnect();
	}, [updateScrollFades]);

	const scrollFadeMask = useMemo(() => {
		const top = canScrollUp ? "transparent" : "#000";
		const bottom = canScrollDown ? "transparent" : "#000";
		return `linear-gradient(to bottom, ${top} 0, #000 20px, #000 calc(100% - 44px), ${bottom} 100%)`;
	}, [canScrollUp, canScrollDown]);

	const isPathActive = (path: string, matchChildren: boolean = false) => {
		const basePath = path.split("?")[0] ?? path;
		if (matchChildren) {
			return pathname === basePath || pathname.startsWith(`${basePath}/`);
		}

		return pathname === basePath;
	};

	const isDomainSetupVerified =
		activeOrg?.organization.customDomain &&
		activeOrg?.organization.domainVerified;

	return (
		<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
			<div className="flex flex-col flex-1 w-full min-h-0">
				<div className="shrink-0">
					<Popover open={open} onOpenChange={setOpen}>
						<Tooltip
							disable={open || sidebarCollapsed === false}
							position="right"
							content={activeOrg?.organization.name ?? "No organization found"}
						>
							<PopoverTrigger suppressHydrationWarning asChild>
								<motion.div
									transition={{
										ease: "easeInOut",
										duration: 0.2,
									}}
									className={clsx(
										"mx-auto rounded-xl transition-colors cursor-pointer dashboard-nav-hover data-[state=open]:bg-gray-3",
										sidebarCollapsed ? "w-fit p-1.5" : "w-full px-2 py-1.5",
									)}
								>
									<div
										className={clsx(
											"flex flex-col items-center cursor-pointer",
											sidebarCollapsed ? "justify-center" : "justify-between",
										)}
										role="combobox"
										aria-expanded={open}
										tabIndex={0}
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
												<SignedImageUrl
													image={activeOrg?.organization.iconUrl}
													name={
														activeOrg?.organization.name ??
														"No organization found"
													}
													letterClass={clsx(
														sidebarCollapsed ? "text-sm" : "text-[13px]",
													)}
													className={clsx(
														"relative flex-shrink-0 mx-auto",
														sidebarCollapsed ? "size-7" : "size-8",
													)}
												/>
											</div>
											<div
												className={clsx(
													"flex flex-col flex-1 gap-0.5 justify-center min-w-0",
													sidebarCollapsed && "hidden",
												)}
											>
												<div className="flex gap-1 justify-between items-center w-full">
													{!sidebarCollapsed && (
														<p
															title={activeOrg?.organization.name}
															className="text-sm font-medium leading-tight truncate text-gray-12"
														>
															{activeOrg?.organization.name ??
																"No organization found"}
														</p>
													)}
													{!sidebarCollapsed && (
														<ChevronsUpDown className="size-3.5 shrink-0 text-gray-9" />
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
														className="flex overflow-hidden gap-1 items-center self-start w-full truncate group/domain"
													>
														<FontAwesomeIcon
															icon={
																isDomainSetupVerified ? faLink : faCircleInfo
															}
															className="size-2.5 shrink-0 text-gray-9"
														/>
														<p className="flex-1 w-full text-xs leading-tight truncate transition-colors text-gray-10 group-hover/domain:text-gray-12">
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
											"p-0 w-[300px] z-[120]",
											sidebarCollapsed ? "ml-3" : "mx-auto",
										)}
									>
										<Command
											filter={(value, search) =>
												commandScore(
													organizationSearchText.get(value) ?? value,
													search,
												)
											}
										>
											<CommandInput placeholder="Search organizations..." />
											<CommandEmpty>No organizations found</CommandEmpty>
											<CommandGroup className="overflow-y-auto max-h-[min(60vh,440px)]">
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
																	: "text-gray-10 hover:text-gray-12 hover:bg-gray-3",
															)}
															key={`${organization.organization.name}-organization-${organization.organization.id}`}
															value={organization.organization.id}
															onSelect={async () => {
																await updateActiveOrganization(
																	organization.organization.id,
																);
																setOpen(false);
																router.push("/dashboard/caps");
															}}
														>
															<div className="flex gap-2 items-center w-full min-w-0">
																<SignedImageUrl
																	image={organization.organization.iconUrl}
																	name={organization.organization.name}
																	letterClass="text-xs"
																	className="relative flex-shrink-0 size-5"
																/>
																<p
																	title={organization.organization.name}
																	className={clsx(
																		"flex-1 min-w-0 text-sm truncate transition-colors duration-200 group-hover:text-gray-12",
																		isSelected
																			? "text-gray-12"
																			: "text-gray-10",
																	)}
																>
																	{organization.organization.name}
																</p>
															</div>
															{isSelected && (
																<Check
																	size={16}
																	className="ml-auto shrink-0 text-gray-12"
																/>
															)}
														</CommandItem>
													);
												})}
											</CommandGroup>
											<div className="p-1 border-t border-gray-3">
												<DialogTrigger asChild>
													<button
														type="button"
														className="flex gap-2 items-center px-2 w-full h-9 text-sm rounded-lg transition-colors text-gray-11 hover:bg-gray-3 hover:text-gray-12"
													>
														<span className="flex justify-center items-center rounded-md border border-dashed size-5 border-gray-7">
															<Plus className="size-3" />
														</span>
														New organization
													</button>
												</DialogTrigger>
											</div>
										</Command>
									</PopoverContent>
								</motion.div>
							</PopoverTrigger>
						</Tooltip>
					</Popover>
					<MemberAvatars />
				</div>
				<nav
					className="flex flex-col flex-1 w-full min-h-0"
					aria-label="Sidebar"
				>
					<div
						ref={scrollRef}
						onScroll={updateScrollFades}
						className="overflow-y-auto flex-1 min-h-0"
						style={{
							scrollbarWidth: "none",
							msOverflowStyle: "none",
							maskImage: scrollFadeMask,
							WebkitMaskImage: scrollFadeMask,
						}}
					>
						<div
							ref={contentRef}
							className={clsx(
								"pt-4",
								sidebarCollapsed ? "flex flex-col items-center" : "",
							)}
						>
							{manageNavigation
								.filter((item) => !item.ownerOnly || isOwner)
								.filter((item) => !item.adminOnly || canViewSettings)
								.map((item) => (
									<div
										key={item.name}
										className="flex relative justify-center items-center mb-0.5 w-full"
									>
										{isPathActive(item.href, item.matchChildren ?? false) && (
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
												className="absolute w-full h-9 rounded-lg pointer-events-none dashboard-nav-active"
											/>
										)}

										<NavItem
											name={item.name}
											href={item.href}
											icon={item.icon}
											sidebarCollapsed={sidebarCollapsed}
											toggleMobileNav={toggleMobileNav}
											isPathActive={isPathActive}
											extraText={item.extraText}
											matchChildren={item.matchChildren ?? false}
										/>
									</div>
								))}

							<SpacesList toggleMobileNav={() => toggleMobileNav?.()} />
						</div>
					</div>
					<div className="pt-2 pb-3 w-full shrink-0">
						<UsageButton
							toggleMobileNav={() => toggleMobileNav?.()}
							subscribed={user.isPro}
						/>
						{buildEnv.NEXT_PUBLIC_IS_CAP && (
							<Tooltip
								disable={!sidebarCollapsed}
								position="right"
								content="Earn 40% referral"
							>
								<Link
									href="/dashboard/refer"
									className={clsx(
										"flex gap-2.5 items-center mt-1.5 h-9 text-sm rounded-lg transition-colors text-gray-11 hover:text-gray-12 dashboard-nav-hover",
										sidebarCollapsed ? "justify-center mx-auto size-9" : "px-3",
									)}
								>
									<Gift className="size-4 shrink-0 text-gray-10" />
									{!sidebarCollapsed && (
										<span className="truncate">Earn 40% referral</span>
									)}
								</Link>
							</Tooltip>
						)}
						{!sidebarCollapsed && (
							<p className="px-3 mt-1 text-[11px] truncate text-gray-9">
								Cap Software, Inc. {new Date().getFullYear()}
							</p>
						)}
					</div>
				</nav>
			</div>
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
	matchChildren,
	extraText,
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
	isPathActive: (path: string, matchChildren: boolean) => boolean;
	extraText: number | null | undefined;
	matchChildren: boolean;
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
				prefetch={href !== INFRA_BASE_PATH}
				passHref
				className={classNames(
					"relative border border-transparent transition z-3",
					sidebarCollapsed
						? "flex justify-center items-center px-0 w-full size-9"
						: "px-3 w-full h-9",
					isPathActive(href, matchChildren)
						? "bg-transparent pointer-events-none"
						: "dashboard-nav-hover",
					"flex overflow-hidden justify-start items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-gray-6",
				)}
			>
				{cloneElement(icon, {
					ref: iconRef,
					className: clsx(
						sidebarCollapsed && "mx-auto",
						isPathActive(href, matchChildren) ? "text-gray-12" : "text-gray-10",
					),
					size: sidebarCollapsed ? 18 : 16,
				})}
				<p
					className={clsx(
						"text-sm truncate",
						isPathActive(href, matchChildren)
							? "font-medium text-gray-12"
							: "text-gray-11",
						sidebarCollapsed ? "hidden" : "ml-2.5",
					)}
				>
					{name}
				</p>
				{extraText !== null && !sidebarCollapsed && (
					<p className="ml-auto text-xs tabular-nums text-gray-10">
						{extraText}
					</p>
				)}
			</Link>
		</Tooltip>
	);
};

export default AdminNavItems;
