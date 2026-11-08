"use client";

import { Check, Server } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { CapLogoMark } from "../demo/capIcons";
import { copyOf, STORAGE_COPY } from "./copy";
import { type Scene, Showcase, seg, TONES } from "./kit";
import { RecordingFrame } from "./share";

export const CANVAS = { w: 1040, h: 440 } as const;

type Destination = {
	key: string;
	label: string;
	name: string;
	path: string;
	note: string;
	icon: ReactNode;
	tab: ReactNode;
	lead: string;
	body: string;
};

const DESTINATIONS: Destination[] = [
	{
		key: "cloud",
		label: copyOf(STORAGE_COPY, "cloud").label,
		name: "Cap Cloud",
		path: "Cap.so/s/m4k8x2qz",
		note: "Encrypted, shareable the second it lands",
		icon: <CapLogoMark className="size-7" />,
		tab: <CapLogoMark />,
		lead: copyOf(STORAGE_COPY, "cloud").lead,
		body: copyOf(STORAGE_COPY, "cloud").body,
	},
	{
		key: "s3",
		label: copyOf(STORAGE_COPY, "s3").label,
		name: "acme-recordings",
		path: "s3://acme-recordings",
		note: "eu-west-2 · your keys, your bill",
		icon: (
			<span className="grid size-7 place-items-center rounded-[7px] bg-[#111111] text-[11px] font-semibold text-white">
				S3
			</span>
		),
		tab: (
			<span className="grid size-4 place-items-center rounded-[4px] bg-current text-[7px] font-bold">
				<span className="text-white">S3</span>
			</span>
		),
		lead: copyOf(STORAGE_COPY, "s3").lead,
		body: copyOf(STORAGE_COPY, "s3").body,
	},
	{
		key: "drive",
		label: copyOf(STORAGE_COPY, "drive").label,
		name: "Google Drive",
		path: "My Drive / Cap",
		note: "A folder your team already uses",
		icon: (
			<Image
				src="/logos/google-drive.svg"
				alt=""
				width={28}
				height={28}
				className="size-7"
			/>
		),
		tab: <Image src="/logos/google-drive.svg" alt="" width={16} height={16} />,
		lead: copyOf(STORAGE_COPY, "drive").lead,
		body: copyOf(STORAGE_COPY, "drive").body,
	},
	{
		key: "self",
		label: copyOf(STORAGE_COPY, "self").label,
		name: "Cap on your servers",
		path: "recordings.acme.internal",
		note: "The whole platform, on your servers",
		icon: <Server className="size-6 text-[#111111]" />,
		tab: <Server />,
		lead: copyOf(STORAGE_COPY, "self").lead,
		body: copyOf(STORAGE_COPY, "self").body,
	},
];

const FILE = { x: 96, y: 96, w: 312, h: 236 };
const DEST = { x: 632, y: 132, w: 312, h: 164 };
const ACCENT = TONES.storage.accent;

const DOTS = {
	backgroundImage:
		"radial-gradient(circle at 1px 1px, rgba(17,17,17,0.09) 1px, transparent 0)",
	backgroundSize: "18px 18px",
	maskImage:
		"radial-gradient(ellipse 70% 75% at 50% 45%, #000 40%, transparent 100%)",
} as const;

const RouteView =
	(destination: Destination) =>
	({ t, playing }: { t: number; playing: boolean }) => {
		const travel = seg(t, 500, 2400);
		const done = t > 2500;
		const startX = FILE.x + FILE.w;
		const endX = DEST.x;
		const y = DEST.y + DEST.h / 2;
		const pct = Math.round(travel * 100);
		return (
			<div className="absolute inset-0">
				<div className="absolute inset-0" style={DOTS} />

				<div
					className="absolute overflow-hidden rounded-[18px] bg-white shadow-[0_0_0_1px_rgba(17,17,17,0.07),0_24px_60px_-30px_rgba(17,24,39,0.45)]"
					style={{ left: FILE.x, top: FILE.y, width: FILE.w, height: FILE.h }}
				>
					<div className="relative m-2 h-[160px] overflow-hidden rounded-[11px]">
						<RecordingFrame playing={playing} pageScale={0.4} />
					</div>
					<div className="flex items-center justify-between px-4 pb-3 pt-1">
						<div>
							<div className="text-[14px] font-semibold text-[#1C1D21]">
								invoice-walkthrough.mp4
							</div>
							<div className="mt-0.5 text-[12.5px] text-[#8A8F98]">
								4K · 0:24 · 96 MB
							</div>
						</div>
						<CapLogoMark className="size-5" />
					</div>
				</div>

				<svg
					aria-hidden="true"
					className="absolute inset-0"
					width={CANVAS.w}
					height={CANVAS.h}
				>
					<path
						d={`M ${startX} ${FILE.y + FILE.h / 2} C ${startX + 110} ${FILE.y + FILE.h / 2}, ${endX - 110} ${y}, ${endX} ${y}`}
						fill="none"
						stroke="#D5DBE3"
						strokeWidth={2}
						strokeDasharray="3 6"
						strokeLinecap="round"
					/>
					<path
						d={`M ${startX} ${FILE.y + FILE.h / 2} C ${startX + 110} ${FILE.y + FILE.h / 2}, ${endX - 110} ${y}, ${endX} ${y}`}
						fill="none"
						stroke={ACCENT}
						strokeWidth={2.5}
						strokeLinecap="round"
						pathLength={1}
						strokeDasharray={1}
						strokeDashoffset={1 - travel}
					/>
				</svg>

				<div
					className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[12.5px] tabular-nums text-[#1C1D21] shadow-[0_0_0_1px_rgba(17,17,17,0.07),0_10px_24px_-12px_rgba(17,24,39,0.35)] transition-opacity duration-300"
					style={{
						left: (startX + endX) / 2,
						top: (FILE.y + FILE.h / 2 + y) / 2,
						opacity: travel > 0 ? 1 : 0,
					}}
				>
					{done ? (
						<>
							<Check className="size-3.5 text-[#16A34A]" strokeWidth={2.6} />
							Uploaded
						</>
					) : (
						<>
							<span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-[#E8EDF3]">
								<span
									className="absolute inset-y-0 left-0 rounded-full"
									style={{ width: `${pct}%`, background: ACCENT }}
								/>
							</span>
							{pct}%
						</>
					)}
				</div>

				<div
					className="absolute flex flex-col justify-between rounded-[18px] bg-white p-5 transition-shadow duration-500"
					style={{
						left: DEST.x,
						top: DEST.y,
						width: DEST.w,
						height: DEST.h,
						boxShadow: done
							? `0 0 0 2px color-mix(in srgb, ${ACCENT} 55%, transparent), 0 0 0 7px color-mix(in srgb, ${ACCENT} 12%, transparent), 0 24px 60px -30px rgba(17,24,39,0.45)`
							: "0 0 0 1px rgba(17,17,17,0.07), 0 24px 60px -30px rgba(17,24,39,0.45)",
					}}
				>
					<div className="flex items-center gap-3">
						<span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-[#F4F6F9]">
							{destination.icon}
						</span>
						<div className="min-w-0">
							<div className="truncate text-[15px] font-semibold text-[#1C1D21]">
								{destination.name}
							</div>
							<div className="truncate text-[12.5px] text-[#8A8F98]">
								{destination.note}
							</div>
						</div>
					</div>
					<div className="flex items-center justify-between gap-3 rounded-[10px] bg-[#F4F6F9] px-3 py-2.5">
						<span className="truncate font-mono text-[12.5px] text-[#33363D]">
							{destination.path}
						</span>
						<span
							className="flex shrink-0 items-center gap-1 text-[12.5px] text-[#16A34A] transition-opacity duration-300"
							style={{ opacity: done ? 1 : 0 }}
						>
							<Check className="size-3.5" strokeWidth={2.6} />
							Saved
						</span>
					</div>
				</div>
			</div>
		);
	};

const SCENES: Scene[] = DESTINATIONS.map((destination) => ({
	key: destination.key,
	label: destination.label,
	icon: destination.tab,
	lead: destination.lead,
	body: destination.body,
	duration: 4200,
	pose: 3000,
	View: RouteView(destination),
}));

export const OwnershipStage = () => (
	<Showcase scenes={SCENES} tone={TONES.storage} canvas={CANVAS} />
);
