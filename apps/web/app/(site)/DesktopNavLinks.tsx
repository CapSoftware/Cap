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
		label: "产品",
		width: 600,
		dropdown: [
			{
				label: "即时模式",
				sub: "快速录制并立即生成分享链接",
				href: "/features/instant-mode",
				icon: <Zap fill="yellow" className="size-4" strokeWidth={1.5} />,
			},
			{
				label: "工作室模式",
				sub: "专业录制与高级编辑",
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
				label: "下载应用",
				sub: "下载 macOS 和 Windows 版本",
				href: "/download",
			},
			{
				label: "开源",
				sub: "Cap 已开源，可在 GitHub 获取",
				href: "https://github.com/CapSoftware/Cap",
			},
			{
				label: "自托管 Cap",
				sub: "在你自己的基础设施上托管 Cap",
				href: "/self-hosting",
			},
			{
				label: "加入社区",
				sub: "在 Discord 加入 Cap 社区",
				href: "https://cap.link/discord",
			},
		],
	},
	{
		label: "下载",
		href: "/download",
	},
	{
		label: "用户评价",
		href: "/testimonials",
	},
	{
		label: "帮助",
		width: 480,
		dropdown: [
			{
				label: "支持",
				sub: "通过 Discord、邮件等方式获取帮助",
				href: "/support",
			},
			{
				label: "文档",
				sub: "Cap 使用文档",
				href: "/docs",
			},
			{
				label: "常见问题",
				sub: "关于 Cap 的常见问题",
				href: "/faq",
			},
			{
				label: "在线支持",
				sub: "通过聊天获取支持",
				href: "https://discord.gg/y8gdQ3WRN3",
			},
		],
	},
	{
		label: "关于",
		href: "/about",
	},
	{
		label: "博客",
		href: "/blog",
	},
	{
		label: "价格",
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
		<nav aria-label="主导航">
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
