"use client";

import { navigationMenuTriggerStyle } from "@cap/ui";
import { classNames } from "@cap/utils";
import { ChevronDown, Clapperboard, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	type CSSProperties,
	type FocusEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

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
				label: "Support",
				sub: "Get help via Discord, email, and more",
				href: "/support",
			},
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

const dropdownStyle = (width: number | undefined): CSSProperties => ({
	width: width ?? 460,
	maxWidth: "calc(100vw - 2rem)",
});

export function DesktopNavLinks() {
	const pathname = usePathname();
	const previousPathname = useRef(pathname);
	const [openDropdown, setOpenDropdown] = useState<string | null>(null);

	useEffect(() => {
		if (previousPathname.current === pathname) {
			return;
		}

		previousPathname.current = pathname;
		setOpenDropdown(null);
	}, [pathname]);

	const closeDropdown = () => setOpenDropdown(null);

	const closeDropdownIfFocusLeaves = (
		event: FocusEvent<HTMLLIElement>,
		label: string,
	) => {
		const nextFocusedElement = event.relatedTarget;

		if (
			nextFocusedElement instanceof Node &&
			event.currentTarget.contains(nextFocusedElement)
		) {
			return;
		}

		setOpenDropdown((current) => (current === label ? null : current));
	};

	return (
		<nav aria-label="Main">
			<ul className="flex items-center px-0 space-x-0 list-none">
				{Links.map((link) => {
					const isOpen = openDropdown === link.label;

					return (
						<li
							key={link.label}
							className="relative"
							onMouseEnter={() => setOpenDropdown(link.label)}
							onMouseLeave={() =>
								setOpenDropdown((current) =>
									current === link.label ? null : current,
								)
							}
							onBlur={(event) => closeDropdownIfFocusLeaves(event, link.label)}
						>
							{link.dropdown ? (
								<>
									<button
										type="button"
										aria-haspopup="true"
										aria-expanded={isOpen}
										onFocus={() => setOpenDropdown(link.label)}
										onClick={() => setOpenDropdown(link.label)}
										className={classNames(
											navigationMenuTriggerStyle(),
											"flex gap-1 items-center px-2 py-0 text-sm font-medium text-gray-10 transition-colors hover:text-blue-9 focus:text-blue-9",
											isOpen && "text-blue-9",
										)}
									>
										{link.label}
										<ChevronDown
											className={classNames(
												"size-3.5 transition-transform duration-200 ease-out",
												isOpen && "rotate-180",
											)}
											strokeWidth={2.25}
											aria-hidden="true"
										/>
									</button>
									<div
										className={classNames(
											"absolute top-full left-1/2 z-50 -translate-x-1/2 pt-3 transition duration-150",
											isOpen
												? "visible block opacity-100"
												: "invisible hidden opacity-0",
										)}
									>
										<div className="relative" style={dropdownStyle(link.width)}>
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
																onClick={closeDropdown}
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
									onClick={closeDropdown}
									className={classNames(
										navigationMenuTriggerStyle(),
										"px-2 py-0 text-sm font-medium text-gray-10 hover:text-blue-9 focus:text-blue-9",
									)}
								>
									{link.label}
								</Link>
							)}
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
