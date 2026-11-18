"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useRef, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { FILM } from "./content";

const SOURCE = { hls: FILM.hls, mp4: FILM.mp4 };
const POSTER = "/blackfriday/poster.webp";

const loadPlayer = () =>
	import("@/components/cap-player/CapPlayer").then((m) => m.CapPlayer);

const CapPlayer = dynamic(loadPlayer, {
	ssr: false,
	loading: () => (
		<Image src={POSTER} alt="" fill sizes="100vw" className="object-cover" />
	),
});

export function Film() {
	const warmed = useRef(false);
	const [playing, setPlaying] = useState(false);

	const warm = () => {
		if (warmed.current) return;
		warmed.current = true;
		void loadPlayer();
		void import("@/components/cap-player/source").then((m) =>
			m.warmSource(SOURCE),
		);
	};

	return (
		<div className="relative aspect-[1920/1010] w-full overflow-hidden rounded-[14px] bg-black shadow-[0_0_0_1px_rgba(245,241,234,0.1),0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:rounded-[20px]">
			{playing ? (
				<CapPlayer
					source={SOURCE}
					title={FILM.title}
					poster={POSTER}
					aspectRatio={FILM.ratio}
					autoPlay
					focusOnMount
					onEnded={() => trackEvent("black_friday_film_completed")}
				/>
			) : (
				<button
					type="button"
					onClick={() => {
						warm();
						setPlaying(true);
						trackEvent("black_friday_film_played");
					}}
					onPointerEnter={warm}
					onFocus={warm}
					className="group absolute inset-0 grid size-full place-items-center focus-visible:outline-none"
				>
					<Image
						src={POSTER}
						alt="A plane tows a Cap banner reading 50% off Cap Pro Yearly, use code BLACKFRIDAY, over the beach"
						fill
						loading="eager"
						fetchPriority="high"
						sizes="(min-width: 1184px) 1120px, 100vw"
						className="object-cover"
					/>
					<span className="relative inline-flex h-11 items-center gap-2.5 rounded-full bg-[rgba(10,10,11,0.72)] px-5 text-[15px] text-[#F5F1EA] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.25)] transition-transform duration-200 group-hover:scale-[1.04] group-focus-visible:ring-2 group-focus-visible:ring-[#F5F1EA] motion-reduce:transition-none sm:h-14 sm:px-6 sm:text-[17px]">
						<svg
							viewBox="0 0 16 16"
							aria-hidden="true"
							className="size-3.5 fill-current"
						>
							<path d="M5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1L5.92 2.4a.6.6 0 0 0-.92.5Z" />
						</svg>
						Watch the film
						<span className="hidden text-[13px] text-[rgba(245,241,234,0.64)] sm:inline">
							0:23, sound on
						</span>
					</span>
				</button>
			)}
		</div>
	);
}
