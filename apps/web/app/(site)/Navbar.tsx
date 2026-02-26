"use client";

import {
	Button,
	Logo,
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
	NavigationMenuTrigger,
	navigationMenuTriggerStyle,
} from "@cap/ui";
import { classNames } from "@cap/utils";
import { Clapperboard, Zap } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import MobileMenu from "@/components/ui/MobileMenu";
import { useCurrentUser } from "../Layout/AuthContext";

const Links = [
	{
		label: "Product",
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

export const Navbar = ({ stars }: NavbarProps) => {
	const pathname = usePathname();
	const [showMobileMenu, setShowMobileMenu] = useState(false);
	const auth = useCurrentUser();

	const [hideLogoName, setHideLogoName] = useState(false);

	useEffect(() => {
		const onScroll = () => {
			setHideLogoName(window.scrollY > 10);
		};
		document.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			document.removeEventListener("scroll", onScroll);
		};
	}, []);

	return (
		<>
			<header className="fixed left-0 right-0 z-[51] animate-in fade-in slide-in-from-top-4 duration-500 top-4 lg:top-6">
				<nav className="p-2 mx-auto w-full max-w-[calc(100%-20px)] bg-white rounded-full border backdrop-blur-md lg:max-w-fit border-zinc-200 h-fit">
					<div className="flex gap-12 justify-between items-center mx-auto max-w-5xl h-full transition-all">
						<div className="flex items-center">
							<Link passHref href="/home">
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
								<NavigationMenu>
									<NavigationMenuList className="space-x-0">
										{Links.map((link) => (
											<NavigationMenuItem key={link.label}>
												{link.dropdown ? (
													<>
														<NavigationMenuTrigger
															className={
																"px-2 py-0 text-sm font-medium text-gray-10 active:text-gray-10 focus:text-gray-10 hover:text-blue-9"
															}
														>
															{link.label}
														</NavigationMenuTrigger>
														<NavigationMenuContent>
															<ul className="grid gap-3 p-6 md:w-[400px] lg:w-[500px] lg:grid-cols-2">
																{link.dropdown.map((sublink) => (
																	<li key={sublink.href}>
																		<NavigationMenuLink asChild>
																			<a
																				href={sublink.href}
																				className="block p-3 space-y-1 leading-none no-underline rounded-md transition-all duration-200 outline-none select-none hover:bg-gray-2 hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
																			>
																				<div className="flex gap-2 items-center text-base font-medium leading-none transition-colors duration-200 text-zinc-700 group-hover:text-zinc-900">
																					{sublink.icon && sublink.icon}
																					<span className="font-semibold text-gray-12">
																						{sublink.label}
																					</span>
																				</div>
																				<p className="text-sm leading-snug transition-colors duration-200 line-clamp-2 text-zinc-500 group-hover:text-zinc-700">
																					{sublink.sub}
																				</p>
																			</a>
																		</NavigationMenuLink>
																	</li>
																))}
															</ul>
														</NavigationMenuContent>
													</>
												) : (
													<NavigationMenuLink asChild>
														<Link
															href={link.href}
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
													</NavigationMenuLink>
												)}
											</NavigationMenuItem>
										))}
									</NavigationMenuList>
								</NavigationMenu>
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
								className="w-full font-medium sm:w-auto whitespace-nowrap"
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
			className="w-full font-medium sm:w-auto whitespace-nowrap"
		>
			{auth ? "Dashboard" : "Sign Up"}
		</Button>
	);
}
