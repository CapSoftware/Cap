"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { FILM } from "./content";
import { GHOST } from "./theme";

export const FILM_EVENT = "cap:black-friday-film";

const SOURCE = { hls: FILM.hls, mp4: FILM.mp4 };

const loadPlayer = () =>
	import("@/components/cap-player/CapPlayer").then((m) => m.CapPlayer);

const CapPlayer = dynamic(loadPlayer, {
	ssr: false,
	loading: () => <div className="absolute inset-0 bg-black" />,
});

export function Film() {
	const frame = useRef<HTMLDivElement>(null);
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

	const play = (location: string) => {
		warm();
		const video = frame.current?.querySelector("video");
		if (playing && video) void video.play().catch(() => {});
		else setPlaying(true);
		trackEvent("black_friday_film_played", { cta_location: location });
	};

	useEffect(() => {
		const onPlay = () => {
			const reduce = window.matchMedia(
				"(prefers-reduced-motion: reduce)",
			).matches;
			frame.current?.scrollIntoView({
				behavior: reduce ? "auto" : "smooth",
				block: "center",
			});
			play("hero");
		};
		window.addEventListener(FILM_EVENT, onPlay);
		return () => window.removeEventListener(FILM_EVENT, onPlay);
	});

	return (
		<div
			ref={frame}
			className="relative aspect-[1920/1010] w-full overflow-hidden rounded-[18px] bg-black shadow-[0_0_0_1px_rgba(245,241,234,0.08),0_50px_140px_-30px_rgba(255,77,141,0.28),0_40px_120px_-20px_rgba(0,0,0,0.9)]"
		>
			{playing ? (
				<CapPlayer
					source={SOURCE}
					title={FILM.title}
					poster="/blackfriday/poster.webp"
					aspectRatio={FILM.ratio}
					autoPlay
					focusOnMount
					onEnded={() => trackEvent("black_friday_film_completed")}
				/>
			) : (
				<button
					type="button"
					onClick={() => play("film")}
					onPointerEnter={warm}
					onFocus={warm}
					aria-label="Play the Cap Friday film"
					className="group absolute inset-0 grid size-full place-items-center bg-black focus-visible:outline-none"
				>
					<Image
						src="/blackfriday/poster.webp"
						alt=""
						fill
						sizes="(min-width: 1184px) 1120px, 100vw"
						className="absolute inset-0 size-full object-cover transition-[transform,filter] duration-700 [transition-timing-function:cubic-bezier(0.2,0.7,0.2,1)] group-hover:scale-[1.015] group-hover:brightness-105 motion-reduce:transition-none"
					/>
					<span className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(10,10,11,0)_30%,rgba(10,10,11,0.45)_100%)]" />
					<span
						className={`${GHOST} relative h-14 gap-3 px-6 text-[17px] shadow-[inset_0_0_0_1px_rgba(245,241,234,0.4),0_0_50px_rgba(255,77,141,0.45)] transition-transform duration-300 group-hover:scale-[1.04] group-focus-visible:ring-2 group-focus-visible:ring-[#F5F1EA] motion-reduce:transition-none`}
					>
						<svg
							viewBox="0 0 16 16"
							aria-hidden="true"
							className="size-3.5 fill-current"
						>
							<path d="M5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1L5.92 2.4a.6.6 0 0 0-.92.5Z" />
						</svg>
						Play the film
						<span className="text-[13px] text-[rgba(245,241,234,0.64)]">
							0:23, sound on
						</span>
					</span>
				</button>
			)}
		</div>
	);
}

export function WatchFilm() {
	return (
		<button
			type="button"
			className="group inline-flex h-12 items-center gap-2 rounded-full px-3 text-[16px] text-[rgba(245,241,234,0.78)] transition-colors hover:text-[#F5F1EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA]"
			onClick={() => window.dispatchEvent(new Event(FILM_EVENT))}
		>
			<svg
				viewBox="0 0 16 16"
				aria-hidden="true"
				className="size-3 fill-current"
			>
				<path d="M5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1L5.92 2.4a.6.6 0 0 0-.92.5Z" />
			</svg>
			Watch the film
		</button>
	);
}
