"use client";

import { navigationMenuTriggerStyle } from "@cap/ui/navigation-menu";
import { classNames } from "@cap/utils/helpers";
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
				sub: "Downloads for macOS, Windows & Linux",
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
				label: "Changelog",
				sub: "New features, improvements, and fixes",
				href: "/changelog",
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

const BUBBLE_CSS = `
.ht-nav-bubble {
	transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1),
		width 300ms cubic-bezier(0.22, 1, 0.36, 1),
		height 300ms cubic-bezier(0.22, 1, 0.36, 1),
		opacity 180ms ease;
	animation: ht-nav-bubble-in 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes ht-nav-bubble-in {
	from { opacity: 0; scale: 0.86; }
	to { opacity: 1; scale: 1; }
}
`;

export function DesktopNavLinks() {
	const pathname = usePathname();
	const previousPathname = useRef(pathname);
	const [openDropdown, setOpenDropdown] = useState<string | null>(null);
	const listRef = useRef<HTMLUListElement | null>(null);
	const [bubble, setBubble] = useState<{
		x: number;
		y: number;
		w: number;
		h: number;
	} | null>(null);
	const [bubbleOn, setBubbleOn] = useState(false);

	const showBubble = (item: HTMLElement) => {
		const list = listRef.current;
		if (!list) return;
		const rect = item.getBoundingClientRect();
		const base = list.getBoundingClientRect();
		setBubble({
			x: rect.left - base.left,
			y: rect.top - base.top,
			w: rect.width,
			h: rect.height,
		});
		setBubbleOn(true);
	};

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
			<ul
				ref={listRef}
				className="relative flex items-center gap-0.5 px-0 list-none"
				onMouseLeave={() => setBubbleOn(false)}
			>
				{bubble ? (
					<span
						aria-hidden="true"
						className="ht-nav-bubble pointer-events-none absolute left-0 top-0 z-0 rounded-[8px] bg-gray-3"
						style={{
							transform: `translate(${bubble.x}px, ${bubble.y}px)`,
							width: bubble.w,
							height: bubble.h,
							opacity: bubbleOn ? 1 : 0,
						}}
					/>
				) : null}
				{Links.map((link) => {
					const isOpen = openDropdown === link.label;

					return (
						<li
							key={link.label}
							className="relative z-10"
							onMouseEnter={(event) => {
								showBubble(event.currentTarget);
								setOpenDropdown(link.label);
							}}
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
											"bg-transparent hover:bg-transparent focus:bg-transparent data-[state=open]:bg-transparent",
											"flex gap-1.5 items-center px-2.5 py-2 text-[14.5px] font-medium text-[rgba(17,17,17,0.85)] transition-colors hover:text-[#111111] focus:text-[#111111] xl:px-3 xl:text-[15.5px]",
											isOpen && "text-[#111111]",
										)}
									>
										{link.label}
										<ChevronDown
											className={classNames(
												"size-[15px] transition-transform duration-200 ease-out",
												isOpen && "rotate-180",
											)}
											strokeWidth={2}
											aria-hidden="true"
										/>
									</button>
									<div
										className={classNames(
											"absolute top-full left-0 z-50 pt-3 transition duration-150",
											isOpen
												? "visible block opacity-100"
												: "invisible hidden opacity-0",
										)}
									>
										<div className="relative" style={dropdownStyle(link.width)}>
											<div className="overflow-hidden relative bg-white rounded-2xl border border-zinc-200/70">
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
										"bg-transparent hover:bg-transparent focus:bg-transparent data-[state=open]:bg-transparent",
										"px-2.5 py-2 text-[14.5px] font-medium text-[rgba(17,17,17,0.85)] hover:text-[#111111] focus:text-[#111111] xl:px-3 xl:text-[15.5px]",
									)}
								>
									{link.label}
								</Link>
							)}
						</li>
					);
				})}
			</ul>
			<style>{BUBBLE_CSS}</style>
		</nav>
	);
}
