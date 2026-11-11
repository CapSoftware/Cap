import Link from "next/link";
import { LINKS } from "./content";
import { Plain } from "./Plain";
import { BODY, BTN_GHOST, BTN_PRIMARY, H_DISPLAY, MUTED } from "./theme";

export const FinalCta = () => (
	<section className="border-t border-[rgba(236,232,225,0.07)]">
		<Plain
			night
			horizon="72%"
			slab={{
				width: "clamp(150px, 20vw, 280px)",
				height: "clamp(60px, 7vw, 100px)",
			}}
			className="h-[clamp(640px,86svh,820px)]"
		>
			<div className="relative mx-auto flex max-w-[860px] flex-col items-center px-5 pt-24 text-center sm:pt-28">
				<h2
					className={`${H_DISPLAY} bg-[linear-gradient(180deg,#FFFFFF_0%,#ECE8E1_50%,rgba(236,232,225,0.6)_100%)] bg-clip-text text-[clamp(40px,6vw,76px)] text-transparent`}
				>
					Fast video infrastructure.
				</h2>
				<p
					className={`${BODY} mt-6 max-w-[500px] text-balance text-[16.5px] leading-[1.6] sm:text-[18px]`}
				>
					Create an app, grab a key and upload your first video. Encoding is on
					us.
				</p>
				<div className="mt-9 flex w-full flex-col gap-3 min-[420px]:w-auto min-[420px]:flex-row">
					<Link href={LINKS.start} className={BTN_PRIMARY}>
						Start building
					</Link>
					<Link href={LINKS.docs} className={BTN_GHOST}>
						Read the docs
					</Link>
				</div>
				<p className={`${MUTED} mt-8 text-[13.5px] leading-[1.5]`}>
					Bring your agent. Apps, keys, videos and credits are all in the Cap
					CLI and MCP.
				</p>
				<p className={`${MUTED} mt-2 text-[13.5px] leading-[1.5]`}>
					SOC 2 Type II, ISO 27001 and HIPAA compliant. BAA available.
				</p>
			</div>
		</Plain>
	</section>
);
