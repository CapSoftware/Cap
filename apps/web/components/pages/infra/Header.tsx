import { Logo } from "@cap/ui/logo";
import Link from "next/link";
import { LINKS, NAV_LINKS } from "./content";

const NAV_ITEM =
	"rounded-[8px] px-3 py-2 text-[14px] text-[rgba(236,232,225,0.62)] transition-colors duration-200 hover:text-[#ECE8E1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ECE8E1]";

export const Header = () => (
	<header className="fixed inset-x-0 top-0 z-50 border-b border-[rgba(236,232,225,0.07)] bg-[rgba(14,15,16,0.62)] backdrop-blur-xl">
		<div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-3 px-4 sm:px-6">
			<div className="flex min-w-0 items-center gap-6">
				<Link
					href="/infra"
					aria-label="Cap Infra"
					className="flex shrink-0 items-center gap-2.5 rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ECE8E1]"
				>
					<Logo
						white
						viewBoxDimensions="0 0 120 40"
						style={{ width: 78, height: 34 }}
					/>
					<span
						aria-hidden="true"
						className="h-5 w-px bg-[rgba(236,232,225,0.2)]"
					/>
					<span className="text-[17px] font-medium tracking-[-0.02em] text-[#ECE8E1]">
						Infra
					</span>
				</Link>
				<nav aria-label="Cap Infra" className="hidden items-center lg:flex">
					{NAV_LINKS.map((link) => (
						<a key={link.href} href={link.href} className={NAV_ITEM}>
							{link.label}
						</a>
					))}
					<Link href={LINKS.docs} className={NAV_ITEM}>
						Docs
					</Link>
				</nav>
			</div>
			<div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
				<Link href={LINKS.signIn} className={NAV_ITEM}>
					Sign in
				</Link>
				<Link
					href={LINKS.start}
					className="inline-flex h-9 items-center whitespace-nowrap rounded-[9px] bg-[#ECE8E1] px-3.5 text-[14px] font-medium text-[#0E0F10] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition-colors duration-200 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ECE8E1] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0E0F10] sm:px-4"
				>
					Start building
				</Link>
			</div>
		</div>
	</header>
);
