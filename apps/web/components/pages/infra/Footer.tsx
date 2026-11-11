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
	"rounded-[6px] text-[14px] text-[rgba(17,17,17,0.6)] transition-colors duration-200 hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]";

export const Footer = () => (
	<footer className="px-5 pb-10 pt-6">
		<div className="mx-auto flex max-w-[1160px] flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex items-center gap-2.5">
				<Logo
					viewBoxDimensions="0 0 120 40"
					style={{ width: 66, height: 28 }}
				/>
				<span
					aria-hidden="true"
					className="h-4 w-px bg-[rgba(17,17,17,0.16)]"
				/>
				<span className="text-[15px] font-medium tracking-[-0.02em] text-[#111111]">
					Infra
				</span>
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
								<a href={link.href} className={LINK}>
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
		<p className="mx-auto mt-8 max-w-[1160px] text-[13px] text-[rgba(17,17,17,0.45)]">
			© Cap Software, Inc. {new Date().getFullYear()}. Cap is open source.
		</p>
	</footer>
);
