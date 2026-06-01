"use client";

import { Button, Logo, navigationMenuTriggerStyle } from "@cap/ui";
import { classNames } from "@cap/utils";
import { ChevronDown, Clapperboard, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import MobileMenu from "@/components/ui/MobileMenu";
import { useCurrentUser } from "../Layout/AuthContext";

interface NavDropdownItem {
	label: string;
	sub: string;
	href: string;
	icon?: React.ReactNode;
}

interface NavItem {
	label: string;
	href?: string;
	width?: number;
	dropdown?: NavDropdownItem[];
}

const Links: NavItem[] = [
	{
		label: "Product",
		width: 600,
		dropdown: [
			{
				label: "Instant Mode",
				sub: "Quick recordings with instant shareable links",
				href: "/features/instant-mode",
				icon: <Zap fill="yellow" className="size-4" strokeWidth={1.5} />,
			},
			{
				label: "Studio Mode",
				sub: "Professional recordings with advanced editing",
				href: "/features/studio-mode",
				icon: (
					<Clapperboard
						fill="var(--blue-9)"
						className="size-4"
						strokeWidth={1.5}
					/>
				),
			},
			{
				label: "Download App",
				sub: "Downloads for macOS & Windows",
				href: "/download",
			},
			{
				label: "Open Source",
				sub: "Cap is open source and available on GitHub",
				href: "https://github.com/CapSoftware/Cap",
			},
			{
				label: "Self-host Cap",
				sub: "Self-host Cap on your own infrastructure",
				href: "/self-hosting",
			},
			{
				label: "Join the community",
				sub: "Join the Cap community on Discord",
				href: "https://cap.link/discord",
			},
		],
	},
	{
		label: "Download",
		href: "/download",
	},
	{
		label: "Testimonials",
		href: "/testimonials",
	},
	{
		label: "Help",
		width: 480,
		dropdown: [
			{
				label: "Documentation",
				sub: "Documentation for using Cap",
				href: "/docs",
			},
			{
				label: "FAQs",
				sub: "Frequently asked questions about Cap",
				href: "/faq",
			},
			{
				label: "Help Center",
				sub: "Guides, tutorials, and more. Currently in progress.",
				href: "https://help.cap.so",
			},
			{
				label: "Chat support",
				sub: "Support via chat",
				href: "https://discord.gg/y8gdQ3WRN3",
			},
		],
	},
	{
		label: "About",
		href: "/about",
	},
	{
		label: "Blog",
		href: "/blog",
	},
	{
		label: "Pricing",
		href: "/pricing",
	},
];

interface NavbarProps {
	stars?: string;
}

interface PanelPosition {
	left: number;
	width: number;
	arrowLeft: number;
}

const menuTransition = {
	type: "spring" as const,
	stiffness: 350,
	damping: 30,
	mass: 0.8,
	opacity: { duration: 0.15 },
};

export const Navbar = ({ stars }: NavbarProps) => {
	const pathname = usePathname();
	const [showMobileMenu, setShowMobileMenu] = useState(false);
	const auth = useCurrentUser();

	const [hideLogoName, setHideLogoName] = useState(false);
	const [activeMenu, setActiveMenu] = useState<string | null>(null);
	const [panel, setPanel] = useState<PanelPosition | null>(null);

	const navRef = useRef<HTMLElement>(null);
	const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearCloseTimer = useCallback(() => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);

	const closeMenu = useCallback(() => {
		clearCloseTimer();
		setActiveMenu(null);
	}, [clearCloseTimer]);

	const scheduleClose = useCallback(() => {
		clearCloseTimer();
		closeTimer.current = setTimeout(() => setActiveMenu(null), 120);
	}, [clearCloseTimer]);

	const openMenu = useCallback(
		(label: string) => {
			clearCloseTimer();
			const nav = navRef.current;
			const trigger = triggerRefs.current.get(label);
			const item = Links.find((link) => link.label === label);
			if (!nav || !trigger || !item?.dropdown) return;

			const navRect = nav.getBoundingClientRect();
			const triggerRect = trigger.getBoundingClientRect();
			const width = item.width ?? 460;
			const gutter = 12;
			const center = triggerRect.left + triggerRect.width / 2;
			const maxLeft = Math.max(gutter, window.innerWidth - width - gutter);
			const viewportLeft = Math.min(
				Math.max(center - width / 2, gutter),
				maxLeft,
			);

			setPanel({
				left: viewportLeft - navRect.left,
				width,
				arrowLeft: Math.min(Math.max(center - viewportLeft, 20), width - 20),
			});
			setActiveMenu(label);
		},
		[clearCloseTimer],
	);

	useEffect(() => {
		const onScroll = () => {
			setHideLogoName(window.scrollY > 10);
			setActiveMenu(null);
		};
		document.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			document.removeEventListener("scroll", onScroll);
		};
	}, []);

	useEffect(() => {
		if (!activeMenu) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setActiveMenu(null);
		};
		const onResize = () => setActiveMenu(null);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onResize);
		};
	}, [activeMenu]);

	useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

	const activeItem = Links.find((link) => link.label === activeMenu);

	return (
		<>
			<header className="fixed left-0 right-0 z-[51] animate-in fade-in slide-in-from-top-4 duration-500 top-4 lg:top-6">
				<nav
					ref={navRef}
					onMouseLeave={scheduleClose}
					className="relative p-2 mx-auto w-full max-w-[calc(100%-20px)] bg-white rounded-full border backdrop-blur-md lg:max-w-fit border-zinc-200 h-fit"
				>
					<div className="flex gap-12 justify-between items-center mx-auto max-w-5xl h-full transition-all">
						<div className="flex items-center">
							<Link passHref href="/home" onMouseEnter={closeMenu}>
								<Logo
									hideLogoName={hideLogoName}
									className="transition-all duration-200 ease-out"
									viewBoxDimensions={hideLogoName ? "0 0 60 40" : "0 0 120 40"}
									style={{
										width: hideLogoName ? 45.5 : 90,
										height: 40,
									}}
								/>
							</Link>
							<div className="hidden lg:flex">
								<nav aria-label="Main">
									<ul className="flex items-center px-0 space-x-0 list-none">
										{Links.map((link) => (
											<li key={link.label}>
												{link.dropdown ? (
													<button
														type="button"
														ref={(el) => {
															if (el) {
																triggerRefs.current.set(link.label, el);
															} else {
																triggerRefs.current.delete(link.label);
															}
														}}
														aria-haspopup="true"
														aria-expanded={activeMenu === link.label}
														onMouseEnter={() => openMenu(link.label)}
														onFocus={() => openMenu(link.label)}
														onClick={() =>
															activeMenu === link.label
																? closeMenu()
																: openMenu(link.label)
														}
														className={classNames(
															navigationMenuTriggerStyle(),
															"flex gap-1 items-center px-2 py-0 text-sm font-medium transition-colors",
															activeMenu === link.label
																? "text-blue-9"
																: "text-gray-10 hover:text-blue-9",
														)}
													>
														{link.label}
														<ChevronDown
															className={classNames(
																"size-3.5 transition-transform duration-200 ease-out",
																activeMenu === link.label ? "rotate-180" : "",
															)}
															strokeWidth={2.25}
															aria-hidden="true"
														/>
													</button>
												) : (
													<Link
														href={link.href ?? "#"}
														onMouseEnter={closeMenu}
														onFocus={closeMenu}
														className={classNames(
															navigationMenuTriggerStyle(),
															pathname === link.href
																? "text-blue-9"
																: "text-gray-10",
															"px-2 py-0 text-sm font-medium hover:text-blue-9 focus:text-8",
														)}
													>
														{link.label}
													</Link>
												)}
											</li>
										))}
									</ul>
								</nav>
							</div>
						</div>
						<div className="hidden items-center space-x-2 lg:flex">
							<Button
								variant="outline"
								icon={
									<Image
										src="/github.svg"
										alt="Github"
										width={16}
										height={16}
									/>
								}
								target="_blank"
								href="https://github.com/CapSoftware/Cap"
								size="sm"
								className="w-full font-medium sm:w-auto"
							>
								{`GitHub${stars ? ` (${stars})` : ""}`}
							</Button>
							<Suspense
								fallback={
									<Button
										variant="dark"
										disabled
										size="sm"
										className="w-full font-medium sm:w-auto"
									>
										Loading...
									</Button>
								}
							>
								{!auth && (
									<Button
										variant="gray"
										href="/login"
										size="sm"
										className="w-full font-medium sm:w-auto"
									>
										Login
									</Button>
								)}
								<LoginOrDashboard />
							</Suspense>
						</div>
						<button
							type="button"
							className="flex lg:hidden"
							onClick={() => setShowMobileMenu(!showMobileMenu)}
						>
							<div className="flex flex-col gap-[5px] mr-1">
								<motion.div
									initial={{ opacity: 1 }}
									animate={{
										rotate: showMobileMenu ? 45 : 0,
										y: showMobileMenu ? 7 : 0,
									}}
									transition={{ duration: 0.2 }}
									className="w-6 h-0.5 bg-black"
								/>
								<motion.div
									initial={{ opacity: 1 }}
									animate={{
										opacity: showMobileMenu ? 0 : 1,
										x: showMobileMenu ? -5 : 0,
									}}
									transition={{ duration: 0.2 }}
									className="w-6 h-0.5 bg-black"
								/>
								<motion.div
									initial={{ opacity: 1 }}
									animate={{
										rotate: showMobileMenu ? -45 : 0,
										y: showMobileMenu ? -7 : 0,
									}}
									transition={{ duration: 0.2 }}
									className="w-6 h-0.5 bg-black"
								/>
							</div>
						</button>
					</div>

					<AnimatePresence>
						{activeMenu && panel && activeItem?.dropdown && (
							<motion.div
								key={activeMenu}
								className="hidden absolute top-full z-50 pt-3 lg:block"
								style={{
									left: panel.left,
									transformOrigin: `${panel.arrowLeft}px top`,
								}}
								initial={{ opacity: 0, y: -8, scale: 0.96 }}
								animate={{ opacity: 1, y: 0, scale: 1 }}
								exit={{
									opacity: 0,
									y: -4,
									scale: 0.98,
									transition: { duration: 0.12, ease: "easeIn" },
								}}
								transition={menuTransition}
								onMouseEnter={clearCloseTimer}
							>
								<div className="relative" style={{ width: panel.width }}>
									<span
										className="absolute -top-[7px] z-10 size-3.5 rotate-45 rounded-tl-[4px] border-t border-l border-zinc-200/70 bg-white"
										style={{ left: panel.arrowLeft - 7 }}
										aria-hidden="true"
									/>
									<div className="overflow-hidden relative bg-white rounded-2xl border shadow-xl border-zinc-200/70">
										<ul className="grid grid-cols-2 gap-1.5 p-3 list-none">
											{activeItem.dropdown.map((sublink) => (
												<li key={sublink.href}>
													<Link
														href={sublink.href}
														onClick={closeMenu}
														className="block p-3 rounded-xl transition-colors duration-200 outline-none group hover:bg-gray-2 focus-visible:bg-gray-2"
													>
														<div className="flex gap-2 items-center mb-0.5 text-sm font-semibold text-gray-12">
															{sublink.icon}
															<span>{sublink.label}</span>
														</div>
														<p className="text-[13px] leading-snug text-zinc-500 line-clamp-2">
															{sublink.sub}
														</p>
													</Link>
												</li>
											))}
										</ul>
									</div>
								</div>
							</motion.div>
						)}
					</AnimatePresence>
				</nav>
			</header>
			{showMobileMenu && (
				<MobileMenu
					setShowMobileMenu={setShowMobileMenu}
					auth={auth}
					stars={stars}
				/>
			)}
		</>
	);
};

function LoginOrDashboard() {
	const auth = useCurrentUser();

	return (
		<Button
			variant="dark"
			href={auth ? "/dashboard" : "/signup"}
			size="sm"
			className="w-full font-medium sm:w-auto"
		>
			{auth ? "Dashboard" : "Sign Up"}
		</Button>
	);
}
