"use client";

import Link from "next/link";
import { Eyebrow } from "./Eyebrow";
import { Fit, SCENES, STAGE } from "./scenes";
import { LazyMount } from "./scenes/engine";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	H_HERO,
	MODE_THEME,
	type ModeKey,
	meshStyle,
} from "./theme";

const REEL: ModeKey[] = ["instant", "studio", "screenshot"];

export const FinalCta = () => (
	<section className="overflow-hidden pb-24 pt-20 lg:pb-28 lg:pt-28">
		<div className="mx-auto flex max-w-[900px] flex-col items-center px-5 text-center">
			<Eyebrow accent={MODE_THEME.share.accent}>Get started</Eyebrow>
			<h2
				className={`${H_HERO} mt-6 text-balance text-[clamp(44px,6.4vw,78px)]`}
			>
				Ready to upgrade how you communicate?
			</h2>
			<p
				className={`${BODY_TEXT} mt-7 max-w-[560px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18px]`}
			>
				All of the work around screen recordings, handled in one place. Capture,
				polish, and share without the busywork.
			</p>
			<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
				<Link href="/pricing" className={BTN_PRIMARY}>
					Upgrade to Cap Pro
				</Link>
				<Link href="/download" className={BTN_SECONDARY}>
					Download for free
				</Link>
			</div>
		</div>

		<div
			aria-hidden="true"
			className="mt-20 flex items-start justify-center gap-5 lg:gap-6"
		>
			{REEL.map((mode, i) => {
				const scene = SCENES[mode];
				const centre = i === 1;
				return (
					<div
						key={mode}
						className={
							centre
								? "w-[min(92vw,640px)] shrink-0 rounded-[22px] p-3"
								: "hidden w-[460px] shrink-0 rounded-[22px] p-3 sm:block"
						}
						style={meshStyle(MODE_THEME[mode])}
					>
						<LazyMount w={STAGE.w} h={STAGE.h}>
							<Fit w={STAGE.w} h={STAGE.h} still>
								<scene.Scene
									chapter={0}
									playing={false}
									staticT={scene.poster}
								/>
							</Fit>
						</LazyMount>
					</div>
				);
			})}
		</div>
	</section>
);
