import { Logo } from "@cap/ui/logo";
import Link from "next/link";
import { LINKS, NAV_LINKS } from "./content";

const NAV_ITEM =
	"rounded-[8px] px-3 py-2 text-[14.5px] text-[rgba(17,17,17,0.7)] transition-colors duration-200 hover:bg-[#EDF1F6] hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]";

export const Header = () => (
	<header className="sticky top-0 z-40 border-b border-[rgba(17,17,17,0.06)] bg-white/85 backdrop-blur-md">
		<div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-3 px-4 sm:px-6">
			<div className="flex min-w-0 items-center gap-6">
				<Link
					href="/infra"
					aria-label="Cap Infra"
					className="flex shrink-0 items-center gap-2.5 rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
				>
					<Logo
						viewBoxDimensions="0 0 120 40"
						style={{ width: 78, height: 34 }}
					/>
					<span
						aria-hidden="true"
						className="h-5 w-px bg-[rgba(17,17,17,0.16)]"
					/>
					<span className="text-[17px] font-medium tracking-[-0.02em] text-[#111111]">
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
					className="inline-flex h-9 items-center whitespace-nowrap rounded-[10px] bg-[#111111] px-3.5 text-[14px] font-medium text-white transition-colors duration-200 hover:bg-[#2A2B2E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2 sm:px-4"
				>
					Start building
				</Link>
			</div>
		</div>
	</header>
);
