"use client";

import { buildEnv } from "@cap/env";
import {
	Command,
	CommandGroup,
	CommandItem,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@cap/ui";
import { faBell } from "@fortawesome/free-solid-svg-icons/faBell";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClickAway } from "@uidotdev/usehooks";
import clsx from "clsx";
import { AnimatePresence } from "framer-motion";
import { Moon, MoreVertical, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
	cloneElement,
	forwardRef,
	type MutableRefObject,
	memo,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { markAsRead } from "@/actions/notifications/mark-as-read";
import Notifications from "@/app/(org)/dashboard/_components/Notifications";
import { resetUser } from "@/app/utils/analytics";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { LazyUpgradeModal } from "@/components/LazyUpgradeModal";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { useDashboardContext, useTheme } from "../../Contexts";
import {
	ArrowUpIcon,
	DownloadIcon,
	HomeIcon,
	LogoutIcon,
	MessageCircleMoreIcon,
	ReferIcon,
	SettingsGearIcon,
} from "../AnimatedIcons";
import type { DownloadIconHandle } from "../AnimatedIcons/Download";
import type { ReferIconHandle } from "../AnimatedIcons/Refer";
import { dashboardTitle } from "../dashboard-titles";
import {
	TOP_BAR_TITLE_SLOT_ID,
	TopBarCrumbSeparator,
	useTopBarTitleWidth,
} from "../TopBarTitle";
import { nextCompactSearch } from "../top-bar-search-fit";
import { DashboardSearch } from "./DashboardSearch";

const Top = () => {
	const { activeSpace, anyNewNotifications } = useDashboardContext();
	const [toggleNotifications, setToggleNotifications] = useState(false);
	const bellRef = useRef<HTMLButtonElement>(null);
	const queryClient = useQueryClient();

	const pathname = usePathname();

	const crumbs = dashboardTitle(pathname);
	const { width: slotTitleWidth } = useTopBarTitleWidth();
	const rowRef = useRef<HTMLDivElement>(null);
	const titleBoxRef = useRef<HTMLDivElement>(null);
	const titleMeasureRef = useRef<HTMLSpanElement>(null);
	const searchRef = useRef<HTMLDivElement>(null);
	const [compactSearch, setCompactSearch] = useState(false);
	const measuredTitle = activeSpace
		? `Spaces / ${activeSpace.name}`
		: crumbs.map((crumb) => crumb.label).join(" / ");

	const fitSearch = useCallback(() => {
		const box = titleBoxRef.current;
		const search = searchRef.current;
		if (!box || !search || search.offsetWidth === 0) return;
		const slot = document.getElementById(TOP_BAR_TITLE_SLOT_ID);
		const titleWidth = slot?.childElementCount
			? slotTitleWidth
			: (titleMeasureRef.current?.offsetWidth ?? 0) + (activeSpace ? 28 : 0);
		const fullSearchWidth = Math.min(
			420,
			Math.max(240, window.innerWidth * 0.28),
		);
		const roomWithFullSearch =
			box.clientWidth + search.offsetWidth - fullSearchWidth;
		setCompactSearch((compact) =>
			nextCompactSearch(compact, titleWidth, roomWithFullSearch),
		);
	}, [slotTitleWidth, activeSpace]);

	useLayoutEffect(() => {
		fitSearch();
	});

	useEffect(() => {
		const row = rowRef.current;
		if (!row) return;
		const observer = new ResizeObserver(() => fitSearch());
		observer.observe(row);
		return () => observer.disconnect();
	}, [fitSearch]);

	const notificationsRef: MutableRefObject<HTMLDivElement> = useClickAway(
		(e) => {
			if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
				setToggleNotifications(false);
			}
		},
	);

	const markAllAsread = useMutation({
		mutationFn: () => markAsRead(),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["notifications"],
			});
		},
		onError: (error) => {
			console.error("Error marking notifications as read:", error);
		},
	});

	return (
		<div
			ref={rowRef}
			className={clsx(
				"flex relative z-40 gap-3 justify-between items-center py-3 pr-2 pl-5 w-full border-b border-gray-3 shrink-0 lg:h-14 lg:py-0 lg:pl-8 lg:pr-3",
				"bg-gray-1 lg:bg-transparent",
				toggleNotifications && "lg:z-[60]",
			)}
		>
			<div ref={titleBoxRef} className="flex flex-col flex-1 gap-0.5 min-w-0">
				<span
					ref={titleMeasureRef}
					aria-hidden
					className="absolute invisible whitespace-nowrap pointer-events-none text-[15px] font-medium tracking-tight"
				>
					{measuredTitle}
				</span>
				{activeSpace && (
					<span className="text-xs text-gray-11 lg:hidden">Space</span>
				)}
				<div className="flex items-center w-full min-w-0 text-lg font-medium tracking-tight leading-6 lg:text-[15px]">
					<div
						id={TOP_BAR_TITLE_SLOT_ID}
						className="flex flex-1 items-center min-w-0 peer empty:hidden"
					/>
					<h1 className="flex items-center min-w-0 text-lg font-medium tracking-tight leading-6 lg:text-[15px] peer-[:not(:empty)]:hidden">
						{activeSpace ? (
							<>
								<Link
									href="/dashboard/spaces/browse"
									className="hidden transition-colors text-gray-10 shrink-0 hover:text-gray-12 lg:inline"
								>
									Spaces
								</Link>
								<span className="hidden lg:contents">
									<TopBarCrumbSeparator />
								</span>
								<SignedImageUrl
									image={activeSpace.iconUrl}
									name={activeSpace.name}
									letterClass="text-xs"
									className="relative flex-shrink-0 self-start mt-0.5 mr-2 size-5 lg:self-auto lg:mt-0"
								/>
								<span className="min-w-0 text-gray-12 [overflow-wrap:anywhere] lg:truncate">
									{activeSpace.name}
								</span>
							</>
						) : (
							crumbs.map((crumb, index) => {
								const isLast = index === crumbs.length - 1;
								return (
									<span
										key={crumb.label}
										className={clsx(
											"flex items-center",
											isLast ? "min-w-0" : "shrink-0",
										)}
									>
										{index > 0 && <TopBarCrumbSeparator />}
										{isLast || !crumb.href ? (
											<span
												className={clsx(
													"[overflow-wrap:anywhere] lg:truncate",
													isLast ? "text-gray-12" : "text-gray-10",
												)}
											>
												{crumb.label}
											</span>
										) : (
											<Link
												href={crumb.href}
												className="transition-colors text-gray-10 hover:text-gray-12"
											>
												{crumb.label}
											</Link>
										)}
									</span>
								);
							})
						)}
					</h1>
				</div>
			</div>
			<div
				ref={searchRef}
				className={clsx(
					"hidden justify-end shrink-0 lg:flex",
					!compactSearch && "lg:w-[clamp(240px,28vw,420px)]",
				)}
			>
				<DashboardSearch compact={compactSearch} />
			</div>
			<div className="flex gap-1.5 justify-end items-center shrink-0">
				{buildEnv.NEXT_PUBLIC_IS_CAP && <ReferButton />}
				<div className="hidden relative lg:flex">
					<button
						type="button"
						data-state={toggleNotifications ? "open" : "closed"}
						ref={bellRef}
						onClick={() => {
							if (anyNewNotifications) {
								markAllAsread.mutate();
							}
							setToggleNotifications(!toggleNotifications);
						}}
						aria-label={`Notifications${
							anyNewNotifications ? " (new notifications available)" : ""
						}`}
						aria-expanded={toggleNotifications}
						className="relative justify-center items-center rounded-full transition-colors cursor-pointer lg:flex hover:bg-gray-3 data-[state=open]:bg-gray-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-6 size-8"
					>
						{anyNewNotifications && (
							<div className="absolute right-1 top-1 z-10">
								<div className="relative">
									<div className="absolute inset-0 w-2 h-2 bg-red-400 rounded-full opacity-75 animate-ping" />
									<div className="relative w-2 h-2 bg-red-400 rounded-full ring-2 ring-gray-1" />
								</div>
							</div>
						)}
						<FontAwesomeIcon className="text-gray-11 size-3.5" icon={faBell} />
					</button>
					<AnimatePresence>
						{toggleNotifications && (
							<Notifications
								ref={notificationsRef}
								onClose={() => setToggleNotifications(false)}
							/>
						)}
					</AnimatePresence>
				</div>
				<User />
			</div>
		</div>
	);
};

const User = () => {
	const [menuOpen, setMenuOpen] = useState(false);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const { user } = useDashboardContext();
	const { theme, setThemeHandler } = useTheme();
	const nextTheme = theme === "light" ? "dark" : "light";
	const themeLabel =
		theme === "light" ? "Toggle Dark Mode" : "Toggle Light Mode";

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
				showCondition: buildEnv.NEXT_PUBLIC_IS_CAP && !user.isPro,
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
				name: themeLabel,
				icon: <ThemeMenuIcon />,
				onClick: () => {
					setMenuOpen(false);
					if (document.startViewTransition) {
						document.startViewTransition(() => {
							setThemeHandler(nextTheme);
						});
					} else {
						setThemeHandler(nextTheme);
					}
				},
				iconClassName: "text-gray-11 group-hover:text-gray-12",
				showCondition: true,
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
				name: "Sign Out",
				icon: <LogoutIcon />,
				onClick: () => {
					setMenuOpen(false);
					resetUser();
					signOut();
				},
				iconClassName: "text-gray-11 group-hover:text-gray-12",
				showCondition: true,
			},
		],
		[nextTheme, setThemeHandler, themeLabel, user.isPro],
	);

	return (
		<>
			<LazyUpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
			<Popover open={menuOpen} onOpenChange={setMenuOpen}>
				<PopoverTrigger asChild>
					<div
						data-state={menuOpen ? "open" : "closed"}
						className="flex gap-2 justify-between items-center py-1 pr-1.5 pl-1 ml-1 rounded-full transition-colors cursor-pointer data-[state=open]:bg-gray-3 group lg:gap-1.5 hover:bg-gray-3"
					>
						<div className="flex items-center">
							<SignedImageUrl
								image={user.imageUrl}
								name={user.name ?? "User"}
								letterClass="text-xs lg:text-md"
								className="flex-shrink-0 size-6 text-gray-12"
							/>
							<span className="ml-2 text-sm font-medium truncate text-gray-12 max-w-[96px] sm:max-w-[160px]">
								{user.name ?? "User"}
							</span>
						</div>
						<MoreVertical
							data-state={menuOpen ? "open" : "closed"}
							className="size-4 data-[state=open]:text-gray-12 transition-colors text-gray-9 group-hover:text-gray-12"
						/>
					</div>
				</PopoverTrigger>
				<PopoverContent align="end" className="p-1 w-52">
					<Command>
						<CommandGroup>
							{menuItems
								.filter((item) => item.showCondition)
								.map((item, index) => (
									<MenuItem
										key={index.toString()}
										icon={item.icon}
										name={item.name}
										href={"href" in item ? item.href : undefined}
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
	icon: React.ReactElement<{
		ref: RefObject<DownloadIconHandle | null>;
		className: string;
		size: number;
	}>;
	name: string;
	href?: string;
	onClick: () => void;
	iconClassName?: string;
}

const MenuItem = memo(({ icon, name, href, onClick, iconClassName }: Props) => {
	const iconRef = useRef<DownloadIconHandle>(null);
	const content = (
		<>
			<div className="flex flex-shrink-0 justify-center items-center w-3.5 h-3.5">
				{cloneElement(icon, {
					ref: iconRef,
					className: iconClassName,
					size: 14,
				})}
			</div>
			<p className={clsx("text-sm text-gray-12")}>{name}</p>
		</>
	);

	return (
		<CommandItem
			key={name}
			className="px-2 py-1.5 rounded-lg transition-colors duration-150 cursor-pointer hover:bg-gray-3 aria-selected:bg-gray-3 group"
			onSelect={onClick}
			onMouseEnter={() => {
				iconRef.current?.startAnimation();
			}}
			onMouseLeave={() => {
				iconRef.current?.stopAnimation();
			}}
		>
			{href ? (
				<Link
					className="flex gap-2 items-center w-full"
					href={href}
					prefetch={true}
					onClick={onClick}
				>
					{content}
				</Link>
			) : (
				<div className="flex gap-2 items-center w-full">{content}</div>
			)}
		</CommandItem>
	);
});

const ThemeMenuIcon = forwardRef<
	DownloadIconHandle,
	{ className?: string; size?: number }
>(({ className, size = 14 }, ref) => {
	const { theme } = useTheme();
	const Icon = theme === "light" ? Moon : Sun;

	useImperativeHandle(ref, () => ({
		startAnimation: () => undefined,
		stopAnimation: () => undefined,
	}));

	return <Icon className={className} size={size} />;
});

ThemeMenuIcon.displayName = "ThemeMenuIcon";

const ReferButton = () => {
	const iconRef = useRef<ReferIconHandle>(null);
	const { setReferClickedStateHandler, referClickedState } =
		useDashboardContext();

	return (
		<Link
			href="/dashboard/refer"
			className="hidden relative lg:block"
			onClick={() => {
				setReferClickedStateHandler(true);
			}}
			onMouseEnter={() => {
				iconRef.current?.startAnimation();
			}}
			onMouseLeave={() => {
				iconRef.current?.stopAnimation();
			}}
		>
			{!referClickedState && (
				<div className="absolute right-1 top-1 z-10">
					<div className="relative">
						<div className="absolute inset-0 w-2 h-2 bg-red-400 rounded-full opacity-75 animate-ping" />
						<div className="relative w-2 h-2 bg-red-400 rounded-full ring-2 ring-gray-1" />
					</div>
				</div>
			)}

			<div className="flex justify-center items-center rounded-full transition-colors cursor-pointer hover:bg-gray-3 size-8">
				{cloneElement(<ReferIcon />, {
					ref: iconRef,
					className: "text-gray-11 size-3.5",
				})}
			</div>
		</Link>
	);
};

export default Top;
