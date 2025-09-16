"use client";

import {
	Button,
	ListItem,
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
import { motion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, use, useState } from "react";
import MobileMenu from "@/components/ui/MobileMenu";
import { useAuthContext } from "../Layout/AuthContext";

const Links = [
	{
		label: "Product",
		dropdown: [
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
				label: "Email support",
				sub: "Support via email",
				href: "mailto:hello@cap.so",
			},
			{
				label: "Chat support",
				sub: "Support via chat",
				href: "https://discord.gg/y8gdQ3WRN3",
			},
		],
	},
	{
		label: "Pricing",
		href: "/pricing",
	},
	{
		label: "About",
		href: "/about",
	},
	{
		label: "Blog",
		href: "/blog",
	},
];

export const Navbar = () => {
	const pathname = usePathname();
	const [showMobileMenu, setShowMobileMenu] = useState(false);
	const auth = use(useAuthContext().user);

	return (
		<>
			<header className="fixed top-4 left-0 right-0 z-[51] md:top-10  animate-in fade-in slide-in-from-top-4 duration-500">
				<nav className="p-2 mx-auto w-full max-w-[calc(100%-20px)] bg-white rounded-full border backdrop-blur-md md:max-w-fit border-zinc-200 h-fit">
					<div className="flex gap-12 justify-between items-center mx-auto max-w-4xl h-full transition-all">
						<div className="flex items-center">
							<Link passHref href="/home">
								<Logo className="w-[90px]" />
							</Link>
							<div className="hidden md:flex">
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
																	<ListItem
																		key={sublink.href}
																		href={sublink.href}
																		title={sublink.label}
																	>
																		{sublink.sub}
																	</ListItem>
																))}
															</ul>
														</NavigationMenuContent>
													</>
												) : (
													<Link href={link.href} legacyBehavior passHref>
														<NavigationMenuLink
															className={classNames(
																navigationMenuTriggerStyle(),
																pathname === link.href
																	? "text-blue-9"
																	: "text-gray-10",
																"px-2 py-0 text-sm font-medium hover:text-blue-9 focus:text-8",
															)}
														>
															{link.label}
														</NavigationMenuLink>
													</Link>
												)}
											</NavigationMenuItem>
										))}
									</NavigationMenuList>
								</NavigationMenu>
							</div>
						</div>
						<div className="hidden items-center space-x-2 md:flex">
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
							className="flex md:hidden"
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
				<MobileMenu setShowMobileMenu={setShowMobileMenu} auth={auth} />
			)}
		</>
	);
};

function LoginOrDashboard() {
	const auth = use(useAuthContext().user);

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
