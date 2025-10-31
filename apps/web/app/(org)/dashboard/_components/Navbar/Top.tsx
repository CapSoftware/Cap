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
import { faBell } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ThemeToggleIcon } from "@/components/ThemeToggleIcon";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClickAway } from "@uidotdev/usehooks";
import clsx from "clsx";
import { AnimatePresence } from "framer-motion";
import { MoreVertical } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
	cloneElement,
	type MutableRefObject,
	memo,
	type RefObject,
	useMemo,
	useRef,
	useState,
} from "react";
import { markAsRead } from "@/actions/notifications/mark-as-read";
import Notifications from "@/app/(org)/dashboard/_components/Notifications";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { UpgradeModal } from "@/components/UpgradeModal";
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

const Top = () => {
	const { activeSpace, anyNewNotifications } = useDashboardContext();
	const [toggleNotifications, setToggleNotifications] = useState(false);
	const bellRef = useRef<HTMLDivElement>(null);
	const { theme, setThemeHandler } = useTheme();
	const queryClient = useQueryClient();

	const pathname = usePathname();

	const titles: Record<string, string> = {
		"/dashboard/caps": "Caps",
		"/dashboard/folder": "Caps",
		"/dashboard/shared-caps": "Shared Caps",
		"/dashboard/settings/organization": "Organization Settings",
		"/dashboard/settings/account": "Account Settings",
		"/dashboard/spaces": "Spaces",
		"/dashboard/spaces/browse": "Browse Spaces",
	};

	const title = activeSpace
		? activeSpace.name
		: pathname.includes("/dashboard/folder")
			? "Caps"
			: titles[pathname] || "";

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
				"flex fixed z-40 justify-between items-center py-3 pr-2 pl-5 w-full md:relative mt-[60px] lg:mt-0 lg:py-[19px] lg:pl-0 lg:pr-5",
				"top-0 bg-gray-1",
			)}
		>
			<div className="flex flex-col gap-0.5">
				{activeSpace && <span className="text-xs text-gray-11">Space</span>}
				<div className="flex gap-1.5 items-center">
					{activeSpace && (
						<SignedImageUrl
							image={activeSpace.iconUrl}
							name={activeSpace?.name}
							letterClass="text-xs"
							className="relative flex-shrink-0 size-5"
						/>
					)}
					<p className="relative text-lg truncate text-gray-12 lg:text-2xl">
						{title}
					</p>
				</div>
			</div>
			<div className="flex gap-4 items-center">
				{buildEnv.NEXT_PUBLIC_IS_CAP && <ReferButton />}
				<div
					data-state={toggleNotifications ? "open" : "closed"}
					ref={bellRef}
					onClick={() => {
						if (anyNewNotifications) {
							markAllAsread.mutate();
						}
						setToggleNotifications(!toggleNotifications);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							if (anyNewNotifications) {
								markAllAsread.mutate();
							}
							setToggleNotifications(!toggleNotifications);
						}
					}}
					tabIndex={0}
					role="button"
					aria-label={`Notifications${
						anyNewNotifications ? " (new notifications available)" : ""
					}`}
					aria-expanded={toggleNotifications}
					className="hidden relative justify-center data-[state=open]:hover:bg-gray-5 items-center bg-gray-3
                rounded-full transition-colors cursor-pointer lg:flex
                hover:bg-gray-5 data-[state=open]:bg-gray-5
                focus:outline-none
                size-9"
				>
					{anyNewNotifications && (
						<div className="absolute right-0 top-1 z-10">
							<div className="relative">
								<div className="absolute inset-0 w-2 h-2 bg-red-400 rounded-full opacity-75 animate-ping" />
								<div className="relative w-2 h-2 bg-red-400 rounded-full" />
							</div>
						</div>
					)}
					<FontAwesomeIcon className="text-gray-12 size-3.5" icon={faBell} />
					<AnimatePresence>
						{toggleNotifications && <Notifications ref={notificationsRef} />}
					</AnimatePresence>
				</div>
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
					<ThemeToggleIcon />
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
		[],
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
							<SignedImageUrl
								image={user.imageUrl}
								name={user.name ?? "User"}
								letterClass="text-xs lg:text-md"
								className="flex-shrink-0 size-[24px] text-gray-12"
							/>
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
										key={index.toString()}
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
	const { setReferClickedStateHandler, referClickedState } =
		useDashboardContext();

	return (
		<Link href="/dashboard/refer" className="hidden relative lg:block">
			{!referClickedState && (
				<div className="absolute right-0 top-1 z-10">
					<div className="relative">
						<div className="absolute inset-0 w-2 h-2 bg-red-400 rounded-full opacity-75 animate-ping" />
						<div className="relative w-2 h-2 bg-red-400 rounded-full" />
					</div>
				</div>
			)}

			<div
				onClick={() => {
					setReferClickedStateHandler(true);
				}}
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

export default Top;
