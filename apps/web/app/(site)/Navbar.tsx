import { Button, Logo, navigationMenuTriggerStyle } from "@cap/ui";
import { classNames } from "@cap/utils";
import { ChevronDown, Clapperboard, Zap } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import MobileMenu from "@/components/ui/MobileMenu";

interface NavDropdownItem {
	label: string;
	sub: string;
	href: string;
	icon?: ReactNode;
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

const dropdownStyle = (width: number | undefined): CSSProperties => ({
	width: width ?? 460,
	maxWidth: "calc(100vw - 2rem)",
});

export const Navbar = ({ stars }: NavbarProps) => {
	return (
		<header className="fixed left-0 right-0 z-[51] animate-in fade-in slide-in-from-top-4 duration-500 top-4 lg:top-6">
			<nav className="relative p-2 mx-auto w-full max-w-[calc(100%-20px)] bg-white rounded-full border backdrop-blur-md lg:max-w-fit border-zinc-200 h-fit">
				<div className="flex gap-12 justify-between items-center mx-auto max-w-5xl h-full transition-all">
					<div className="flex items-center">
						<Link passHref href="/home">
							<Logo
								className="transition-all duration-200 ease-out"
								viewBoxDimensions="0 0 120 40"
								style={{
									width: 90,
									height: 40,
								}}
							/>
						</Link>
						<div className="hidden lg:flex">
							<nav aria-label="Main">
								<ul className="flex items-center px-0 space-x-0 list-none">
									{Links.map((link) => (
										<li key={link.label} className="relative group">
											{link.dropdown ? (
												<>
													<button
														type="button"
														aria-haspopup="true"
														className={classNames(
															navigationMenuTriggerStyle(),
															"flex gap-1 items-center px-2 py-0 text-sm font-medium text-gray-10 transition-colors hover:text-blue-9 focus:text-blue-9 group-hover:text-blue-9",
														)}
													>
														{link.label}
														<ChevronDown
															className="size-3.5 transition-transform duration-200 ease-out group-hover:rotate-180 group-focus-within:rotate-180"
															strokeWidth={2.25}
															aria-hidden="true"
														/>
													</button>
													<div className="invisible absolute top-full left-1/2 z-50 hidden -translate-x-1/2 pt-3 opacity-0 transition duration-150 group-hover:visible group-hover:block group-hover:opacity-100 group-focus-within:visible group-focus-within:block group-focus-within:opacity-100">
														<div
															className="relative"
															style={dropdownStyle(link.width)}
														>
															<span
																className="absolute -top-[7px] left-1/2 z-10 size-3.5 -translate-x-1/2 rotate-45 rounded-tl-[4px] border-t border-l border-zinc-200/70 bg-white"
																aria-hidden="true"
															/>
															<div className="overflow-hidden relative bg-white rounded-2xl border shadow-xl border-zinc-200/70">
																<ul className="grid grid-cols-2 gap-1.5 p-3 list-none">
																	{link.dropdown.map((sublink) => (
																		<li key={sublink.href}>
																			<Link
																				href={sublink.href}
																				className="block p-3 rounded-xl transition-colors duration-200 outline-none group/item hover:bg-gray-2 focus-visible:bg-gray-2"
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
													</div>
												</>
											) : (
												<Link
													href={link.href ?? "#"}
													className={classNames(
														navigationMenuTriggerStyle(),
														"px-2 py-0 text-sm font-medium text-gray-10 hover:text-blue-9 focus:text-blue-9",
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
								<Image src="/github.svg" alt="Github" width={16} height={16} />
							}
							target="_blank"
							href="https://github.com/CapSoftware/Cap"
							size="sm"
							className="w-full font-medium sm:w-auto"
						>
							{`GitHub${stars ? ` (${stars})` : ""}`}
						</Button>
						<Button
							variant="gray"
							href="/login"
							size="sm"
							className="w-full font-medium sm:w-auto"
						>
							Login
						</Button>
						<Button
							variant="dark"
							href="/signup"
							size="sm"
							className="w-full font-medium sm:w-auto"
						>
							Sign Up
						</Button>
					</div>
					<details className="group lg:hidden">
						<summary
							className="flex cursor-pointer list-none marker:hidden [&::-webkit-details-marker]:hidden"
							aria-label="Open menu"
						>
							<span className="flex flex-col gap-[5px] mr-1" aria-hidden="true">
								<span className="block w-6 h-0.5 bg-black transition-transform duration-200 group-open:translate-y-[7px] group-open:rotate-45" />
								<span className="block w-6 h-0.5 bg-black transition duration-200 group-open:-translate-x-1 group-open:opacity-0" />
								<span className="block w-6 h-0.5 bg-black transition-transform duration-200 group-open:-translate-y-[7px] group-open:-rotate-45" />
							</span>
						</summary>
						<MobileMenu stars={stars} />
					</details>
				</div>
			</nav>
		</header>
	);
};
