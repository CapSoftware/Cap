import { Logo } from "@cap/ui/logo";
import Link from "next/link";
import { LINKS, NAV_LINKS } from "./content";

const NAV_ITEM =
	"rounded-[6px] px-2.5 py-1.5 text-[13.5px] text-[rgba(232,236,244,0.58)] transition-colors duration-200 hover:text-[#E8ECF4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)]";

export const Header = () => (
	<header className="fixed inset-x-0 top-0 z-50 border-b border-[rgba(222,230,246,0.06)] bg-[rgba(5,5,6,0.6)] backdrop-blur-xl">
		<div className="mx-auto flex h-14 max-w-[1184px] items-center justify-between gap-3 px-5 sm:px-8">
			<div className="flex min-w-0 items-center gap-7">
				<Link
					href="/infra"
					aria-label="Cap Infra"
					className="flex shrink-0 items-center gap-2 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)]"
				>
					<Logo
						white
						viewBoxDimensions="0 0 120 40"
						style={{ width: 64, height: 28 }}
					/>
					<span
						aria-hidden="true"
						className="h-4 w-px bg-[rgba(222,230,246,0.2)]"
					/>
					<span className="text-[15px] font-medium tracking-[-0.02em] text-[#E8ECF4]">
						Infra
					</span>
				</Link>
				<nav aria-label="Cap Infra" className="hidden items-center md:flex">
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
			<div className="flex shrink-0 items-center gap-1.5">
				<Link href={LINKS.signIn} className={NAV_ITEM}>
					Sign in
				</Link>
				<Link
					href={LINKS.start}
					className="inline-flex h-8 items-center whitespace-nowrap rounded-[7px] bg-[#E8ECF4] px-3 text-[13.5px] font-medium text-[#050506] transition-colors duration-200 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.8)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050506]"
				>
					Start building
				</Link>
			</div>
		</div>
	</header>
);
