import { Logo } from "@cap/ui/logo";
import Link from "next/link";
import { ANCHORS, LINKS } from "./content";

const FOOTER_LINKS = [
	{ label: "Cap.so", href: LINKS.home },
	{ label: "Docs", href: LINKS.docs },
	{ label: "Pricing", href: `#${ANCHORS.pricing}` },
	{ label: "Privacy", href: LINKS.privacy },
	{ label: "Terms", href: LINKS.terms },
	{ label: "GitHub", href: LINKS.github },
] as const;

const LINK =
	"rounded-[6px] text-[13px] text-[rgba(232,236,244,0.46)] transition-colors duration-200 hover:text-[#E8ECF4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)]";

export const Footer = ({ anchorBase = "" }: { anchorBase?: string }) => (
	<footer className="border-t border-[rgba(222,230,246,0.07)] px-5 py-8 sm:px-8">
		<div className="mx-auto flex max-w-[1120px] flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex items-center gap-4">
				<Logo
					white
					viewBoxDimensions="0 0 120 40"
					style={{ width: 55, height: 24 }}
				/>
				<p className="m-0 text-[13px] text-[rgba(232,236,244,0.34)]">
					© Cap Software, Inc. {new Date().getFullYear()}
				</p>
			</div>
			<nav aria-label="Footer">
				<ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-3 p-0">
					{FOOTER_LINKS.map((link) => (
						<li key={link.label}>
							{link.href.startsWith("http") ? (
								<a
									href={link.href}
									target="_blank"
									rel="noreferrer"
									className={LINK}
								>
									{link.label}
								</a>
							) : link.href.startsWith("#") ? (
								<a href={`${anchorBase}${link.href}`} className={LINK}>
									{link.label}
								</a>
							) : (
								<Link href={link.href} className={LINK}>
									{link.label}
								</Link>
							)}
						</li>
					))}
				</ul>
			</nav>
		</div>
	</footer>
);
