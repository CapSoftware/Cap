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
import { useParams, usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
	cloneElement,
	forwardRef,
	type MutableRefObject,
	memo,
	type RefObject,
	useImperativeHandle,
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
import { DashboardSearch } from "./DashboardSearch";

const Top = () => {
	const { activeSpace, anyNewNotifications } = useDashboardContext();
	const [toggleNotifications, setToggleNotifications] = useState(false);
	const bellRef = useRef<HTMLButtonElement>(null);
	const queryClient = useQueryClient();

	const pathname = usePathname();
	const params = useParams();

	const titles: Record<string, string> = {
		"/dashboard/caps": "Caps",
		"/dashboard/folder": "Caps",
		"/dashboard/shared-caps": "Shared Caps",
		"/dashboard/caps/record": "Record a Cap",
		"/dashboard/settings/organization": "Organization Settings",
		"/dashboard/settings/organization/preferences": "Organization Settings",
		"/dashboard/settings/organization/content": "Organization Settings",
		"/dashboard/settings/organization/billing": "Organization Settings",
		"/dashboard/settings/organization/members": "Organization Settings",
		"/dashboard/settings/organization/integrations": "Organization Settings",
		"/dashboard/settings/organization/security": "Organization Settings",
		"/dashboard/settings/account": "Account Settings",
		"/dashboard/settings/notifications": "Notification Settings",
		"/dashboard/spaces": "Spaces",
		"/dashboard/spaces/browse": "Browse Spaces",
		"/dashboard/analytics": "Analytics",
		[`/dashboard/folder/${params.id}`]: "Caps",
		[`/dashboard/analytics/s/${params.id}`]: "Analytics: Cap video title",
	};

	const title = activeSpace ? activeSpace.name : titles[pathname] || "";

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
			className={clsx(
				"flex fixed z-40 justify-between items-center py-3 pr-2 pl-5 w-full md:relative mt-[60px] lg:mt-0 lg:h-14 lg:py-0 lg:pl-8 lg:pr-3 lg:border-b lg:border-gray-3",
				"top-0 bg-gray-1 lg:bg-transparent",
				toggleNotifications && "lg:z-[60]",
			)}
		>
			<div className="flex flex-col gap-0.5 min-w-0 shrink lg:max-w-[40%]">
				{activeSpace && (
					<span className="text-xs text-gray-11 lg:hidden">Space</span>
				)}
				<div className="flex gap-2 items-center min-w-0">
					{activeSpace && (
						<span className="hidden text-[15px] text-gray-10 shrink-0 lg:inline">
							Spaces
						</span>
					)}
					{activeSpace && (
						<span aria-hidden className="hidden text-gray-8 shrink-0 lg:inline">
							/
						</span>
					)}
					{activeSpace && (
						<SignedImageUrl
							image={activeSpace.iconUrl}
							name={activeSpace?.name}
							letterClass="text-xs"
							className="relative flex-shrink-0 size-5"
						/>
					)}
					<p className="relative text-lg font-medium tracking-tight truncate text-gray-12 lg:text-[15px]">
						{title}
					</p>
				</div>
			</div>
			<div className="hidden flex-1 justify-center px-6 min-w-0 lg:flex">
				<DashboardSearch />
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
