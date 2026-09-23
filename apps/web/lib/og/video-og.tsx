import { ImageResponse } from "next/og";
import { loadOgAssets } from "@/lib/og/assets";
import { loadOgFonts, OG_MONO } from "@/lib/og/fonts";
import {
	Body,
	CapWordmark,
	Headline,
	MeshFrame,
	OG_HEIGHT,
	OG_INK,
	OG_WIDTH,
	OgCanvas,
} from "@/lib/og/template";
import {
	coverRect,
	loadOgThumbnail,
	type OgThumbnail,
} from "@/lib/og/thumbnail";

export type VideoOgData = {
	title: string;
	ownerName?: string;
	/** Duration in seconds. */
	duration?: number;
	screenshotUrl?: string;
};

export type VideoOgVariant =
	| { kind: "video"; video: VideoOgData }
	| { kind: "locked" }
	| { kind: "password" }
	| { kind: "not-found" };

// Thumbnails and titles can change, so cache briefly at the edge and let
// stale-while-revalidate keep crawler/email fetches instant.
const VIDEO_OG_CACHE_CONTROL =
	"public, max-age=600, s-maxage=3600, stale-while-revalidate=86400";

export const formatDuration = (seconds: number) => {
	const total = Math.max(0, Math.round(seconds));
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	if (mins >= 60) {
		const hours = Math.floor(mins / 60);
		return `${hours}:${String(mins % 60).padStart(2, "0")}:${String(
			secs,
		).padStart(2, "0")}`;
	}
	return `${mins}:${String(secs).padStart(2, "0")}`;
};

const PlayButton = ({ size }: { size: number }) => (
	<div
		style={{
			display: "flex",
			width: size,
			height: size,
			borderRadius: 9999,
			background: "rgba(255,255,255,0.92)",
			alignItems: "center",
			justifyContent: "center",
			boxShadow:
				"0 18px 40px -8px rgba(17,24,39,0.45), 0 0 0 8px rgba(255,255,255,0.28)",
		}}
	>
		<svg
			role="img"
			aria-label="Play"
			width={Math.round(size * 0.36)}
			height={Math.round(size * 0.36)}
			viewBox="0 0 24 24"
			style={{ marginLeft: Math.round(size * 0.05) }}
		>
			<path
				d="M7 3.8c0-.8.9-1.3 1.6-.9l12 7.6c.6.4.6 1.3 0 1.7l-12 7.6c-.7.4-1.6-.1-1.6-.9Z"
				fill={OG_INK}
			/>
		</svg>
	</div>
);

const LockIcon = ({ size }: { size: number }) => (
	<svg
		role="img"
		aria-label="Locked"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke={OG_INK}
		strokeWidth="1.7"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect width="16" height="11" x="4" y="10.5" rx="2.5" />
		<path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
		<path d="M12 15v2" />
	</svg>
);

const SearchIcon = ({ size }: { size: number }) => (
	<svg
		role="img"
		aria-label="Not found"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke={OG_INK}
		strokeWidth="1.7"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</svg>
);

const THUMB_W = 600;
const THUMB_H = Math.round((THUMB_W * 9) / 16);
const FRAME_PAD = 12;

const ThumbnailImage = ({ thumbnail }: { thumbnail: OgThumbnail }) => {
	const rect = coverRect(thumbnail, { width: THUMB_W, height: THUMB_H });
	return (
		<div
			style={{
				display: "flex",
				position: "absolute",
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
				backgroundImage: `url(${thumbnail.src})`,
				backgroundSize: `${rect.width}px ${rect.height}px`,
				backgroundRepeat: "no-repeat",
			}}
		/>
	);
};

const Thumbnail = ({
	mesh,
	thumbnail,
	duration,
}: {
	mesh: string;
	thumbnail?: OgThumbnail;
	duration?: number;
}) => (
	<MeshFrame
		mesh={mesh}
		width={THUMB_W + FRAME_PAD * 2}
		height={THUMB_H + FRAME_PAD * 2}
		padding={FRAME_PAD}
	>
		<div
			style={{
				display: "flex",
				position: "relative",
				width: THUMB_W,
				height: THUMB_H,
				borderRadius: 16,
				overflow: "hidden",
				alignItems: "center",
				justifyContent: "center",
				background: thumbnail ? "#0B0F17" : "rgba(255,255,255,0.35)",
				boxShadow: "0 0 0 1px rgba(17,24,39,0.06)",
			}}
		>
			{thumbnail && <ThumbnailImage thumbnail={thumbnail} />}
			{thumbnail && (
				<div
					style={{
						display: "flex",
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						height: "100%",
						background:
							"linear-gradient(180deg, rgba(17,24,39,0.06) 0%, rgba(17,24,39,0.18) 55%, rgba(17,24,39,0.42) 100%)",
					}}
				/>
			)}
			<PlayButton size={96} />
			{duration != null && duration > 0 && (
				<div
					style={{
						display: "flex",
						position: "absolute",
						right: 16,
						bottom: 16,
						padding: "6px 12px",
						borderRadius: 999,
						background: "rgba(17,17,17,0.72)",
						fontFamily: OG_MONO,
						fontSize: 18,
						letterSpacing: 0.6,
						color: "white",
					}}
				>
					{formatDuration(duration)}
				</div>
			)}
		</div>
	</MeshFrame>
);

const InitialAvatar = ({ name }: { name: string }) => (
	<div
		style={{
			display: "flex",
			width: 44,
			height: 44,
			borderRadius: 9999,
			background: "#111111",
			color: "white",
			fontSize: 20,
			fontWeight: 500,
			alignItems: "center",
			justifyContent: "center",
			boxShadow: "0 0 0 3px rgba(255,255,255,0.7)",
		}}
	>
		{name.trim().charAt(0).toUpperCase()}
	</div>
);

const videoTitleSize = (title: string) => {
	if (title.length <= 24) return 60;
	if (title.length <= 48) return 50;
	return 42;
};

const videoLayout = (
	video: VideoOgData,
	thumbnail: OgThumbnail | undefined,
	assets: Awaited<ReturnType<typeof loadOgAssets>>,
) => {
	return (
		<OgCanvas background={assets.skySplit}>
			<div
				style={{
					display: "flex",
					position: "absolute",
					right: 52,
					top: Math.round((OG_HEIGHT - THUMB_H - FRAME_PAD * 2) / 2) + 20,
				}}
			>
				<Thumbnail
					mesh={assets.mesh}
					thumbnail={thumbnail}
					duration={video.duration}
				/>
			</div>
			<div
				style={{
					display: "flex",
					position: "absolute",
					top: 0,
					left: 0,
					width: 500,
					height: "100%",
					padding: "58px 0 54px 64px",
					flexDirection: "column",
					justifyContent: "space-between",
				}}
			>
				<CapWordmark />
				<div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
					<Headline size={videoTitleSize(video.title)} lines={4}>
						{video.title}
					</Headline>
					{video.ownerName && (
						<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
							<InitialAvatar name={video.ownerName} />
							<span
								style={{
									display: "block",
									fontSize: 22,
									fontWeight: 500,
									color: "rgba(17,17,17,0.72)",
									lineClamp: 1,
								}}
							>
								{video.ownerName}
							</span>
						</div>
					)}
				</div>
				<div style={{ display: "flex", height: 52 }} />
			</div>
		</OgCanvas>
	);
};

const statusLayout = (
	{
		heading,
		subline,
		icon,
	}: {
		heading: string;
		subline: string;
		icon: "lock" | "search";
	},
	assets: Awaited<ReturnType<typeof loadOgAssets>>,
) => (
	<OgCanvas background={assets.skyCenter}>
		<div
			style={{
				display: "flex",
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				padding: "58px 120px 54px",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "space-between",
			}}
		>
			<CapWordmark />
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 26,
					textAlign: "center",
				}}
			>
				<div
					style={{
						display: "flex",
						width: 104,
						height: 104,
						borderRadius: 30,
						alignItems: "center",
						justifyContent: "center",
						background:
							"linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(236,243,252,0.7) 100%)",
						border: "1px solid rgba(255,255,255,0.9)",
						boxShadow:
							"0 24px 48px -16px rgba(40,72,130,0.35), inset 0 -2px 4px rgba(61,119,194,0.12)",
					}}
				>
					{icon === "lock" ? <LockIcon size={48} /> : <SearchIcon size={46} />}
				</div>
				<Headline size={64} lines={2}>
					{heading}
				</Headline>
				<Body size={26}>{subline}</Body>
			</div>
			<div style={{ display: "flex", height: 52 }} />
		</div>
	</OgCanvas>
);

export async function renderVideoOg(variant: VideoOgVariant) {
	const screenshotUrl =
		variant.kind === "video" ? variant.video.screenshotUrl : undefined;
	const [fonts, assets, thumbnail] = await Promise.all([
		loadOgFonts(),
		loadOgAssets(),
		screenshotUrl ? loadOgThumbnail(screenshotUrl) : undefined,
	]);
	const element = (() => {
		switch (variant.kind) {
			case "video":
				return videoLayout(variant.video, thumbnail, assets);
			case "locked":
				return statusLayout(
					{
						heading: "This Cap is private",
						subline: "Ask the owner for access, or sign in to watch it on Cap.",
						icon: "lock",
					},
					assets,
				);
			case "password":
				return statusLayout(
					{
						heading: "This Cap is password protected",
						subline: "Enter the password on Cap to watch this recording.",
						icon: "lock",
					},
					assets,
				);
			case "not-found":
				return statusLayout(
					{
						heading: "This Cap doesn't exist",
						subline:
							"The recording you're looking for has moved or was deleted.",
						icon: "search",
					},
					assets,
				);
		}
	})();

	return new ImageResponse(element, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts,
		headers: {
			"Cache-Control": VIDEO_OG_CACHE_CONTROL,
			"X-Robots-Tag": "noindex",
		},
	});
}
