import { ImageResponse } from "next/og";
import { loadOgFonts } from "@/lib/og/fonts";
import {
	CapAppIcon,
	CapWordmark,
	OG_BLUE,
	OG_HEIGHT,
	OG_WIDTH,
	SkyBackground,
} from "@/lib/og/template";

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
			background: OG_BLUE,
			border: "5px solid rgba(255,255,255,0.9)",
			alignItems: "center",
			justifyContent: "center",
			boxShadow: "0 12px 32px rgba(20,52,120,0.45)",
		}}
	>
		<svg
			role="img"
			aria-label="Play"
			width={Math.round(size * 0.42)}
			height={Math.round(size * 0.42)}
			viewBox="0 0 24 24"
			fill="white"
			style={{ marginLeft: Math.round(size * 0.05) }}
		>
			<path d="M7 4.5 L19.5 12 L7 19.5 Z" />
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
		stroke="white"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
		<path d="M7 11V7a5 5 0 0 1 10 0v4" />
	</svg>
);

/** Browser-chrome card holding the video thumbnail (or a branded fill). */
const VideoCard = ({
	screenshotUrl,
	width,
	fill = "play",
}: {
	screenshotUrl?: string;
	width: number;
	fill?: "play" | "lock" | "logo";
}) => {
	const bodyHeight = Math.round((width * 9) / 16);
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				width,
				borderRadius: 20,
				background: "white",
				boxShadow: "0 30px 60px rgba(20,52,120,0.4)",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					height: 44,
					padding: "0 18px",
					gap: 8,
				}}
			>
				<div
					style={{
						display: "flex",
						width: 12,
						height: 12,
						borderRadius: 9999,
						background: "#FF5F57",
					}}
				/>
				<div
					style={{
						display: "flex",
						width: 12,
						height: 12,
						borderRadius: 9999,
						background: "#FEBC2E",
					}}
				/>
				<div
					style={{
						display: "flex",
						width: 12,
						height: 12,
						borderRadius: 9999,
						background: "#28C840",
					}}
				/>
				<div style={{ display: "flex", flexGrow: 1 }} />
				<div
					style={{
						display: "flex",
						alignItems: "center",
						background: "#F3F4F6",
						borderRadius: 8,
						padding: "4px 14px",
						fontSize: 15,
						fontWeight: 500,
						color: "#6B7280",
					}}
				>
					cap.so
				</div>
				<div style={{ display: "flex", flexGrow: 1 }} />
				<div style={{ display: "flex", width: 52 }} />
			</div>
			<div
				style={{
					display: "flex",
					position: "relative",
					width: "100%",
					height: bodyHeight,
					borderBottomLeftRadius: 20,
					borderBottomRightRadius: 20,
					overflow: "hidden",
					alignItems: "center",
					justifyContent: "center",
					background: `linear-gradient(160deg, #D3E5FF 0%, ${OG_BLUE} 120%)`,
				}}
			>
				{screenshotUrl && (
					// biome-ignore lint/performance/noImgElement: satori renders raw img tags
					<img
						alt="Video thumbnail"
						src={screenshotUrl}
						width={width}
						height={bodyHeight}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							objectFit: "cover",
						}}
					/>
				)}
				{screenshotUrl && (
					// Fade the frame so the play button carries the card.
					<div
						style={{
							display: "flex",
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: "100%",
							background: "rgba(18,32,66,0.32)",
						}}
					/>
				)}
				{fill === "play" && <PlayButton size={92} />}
				{fill === "lock" && (
					<div
						style={{
							display: "flex",
							width: 96,
							height: 96,
							borderRadius: 9999,
							background: "rgba(30,64,150,0.55)",
							alignItems: "center",
							justifyContent: "center",
						}}
					>
						<LockIcon size={44} />
					</div>
				)}
				{fill === "logo" && <CapAppIcon size={96} />}
			</div>
		</div>
	);
};

const InitialAvatar = ({ name }: { name: string }) => (
	<div
		style={{
			display: "flex",
			width: 44,
			height: 44,
			borderRadius: 9999,
			background: "white",
			color: OG_BLUE,
			fontSize: 22,
			fontWeight: 700,
			alignItems: "center",
			justifyContent: "center",
		}}
	>
		{name.trim().charAt(0).toUpperCase()}
	</div>
);

const videoLayout = (video: VideoOgData) => (
	<SkyBackground>
		<div
			style={{
				display: "flex",
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				padding: "52px 60px",
				alignItems: "center",
				gap: 48,
			}}
		>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					flexGrow: 1,
					flexShrink: 1,
					minWidth: 0,
					height: "100%",
					justifyContent: "space-between",
				}}
			>
				<CapWordmark height={52} />
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 26,
						paddingBottom: 6,
					}}
				>
					<span
						style={{
							display: "block",
							fontSize: video.title.length <= 40 ? 52 : 42,
							fontWeight: 700,
							color: "white",
							lineHeight: 1.15,
							letterSpacing: -1,
							lineClamp: 3,
						}}
					>
						{video.title}
					</span>
					{(video.ownerName || video.duration != null) && (
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 14,
							}}
						>
							{video.ownerName && <InitialAvatar name={video.ownerName} />}
							{video.ownerName && (
								<span
									style={{
										fontSize: 24,
										fontWeight: 500,
										color: "rgba(255,255,255,0.95)",
									}}
								>
									{video.ownerName}
								</span>
							)}
							{video.duration != null && video.duration > 0 && (
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 8,
										background: "rgba(255,255,255,0.16)",
										border: "1px solid rgba(255,255,255,0.38)",
										borderRadius: 999,
										padding: "6px 16px",
									}}
								>
									<svg
										role="img"
										aria-label="Play"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="white"
									>
										<path d="M7 4.5 L19.5 12 L7 19.5 Z" />
									</svg>
									<span
										style={{ fontSize: 20, fontWeight: 500, color: "white" }}
									>
										{formatDuration(video.duration)}
									</span>
								</div>
							)}
						</div>
					)}
				</div>
				<span
					style={{
						fontSize: 23,
						fontWeight: 500,
						color: "rgba(255,255,255,0.85)",
					}}
				>
					Watch on Cap.so
				</span>
			</div>
			<div style={{ display: "flex", flexShrink: 0 }}>
				<VideoCard screenshotUrl={video.screenshotUrl} width={560} />
			</div>
		</div>
	</SkyBackground>
);

const statusLayout = ({
	heading,
	subline,
	fill,
}: {
	heading: string;
	subline: string;
	fill: "lock" | "logo";
}) => (
	<SkyBackground>
		<div
			style={{
				display: "flex",
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				padding: "52px 60px",
				flexDirection: "column",
			}}
		>
			<CapWordmark height={52} />
			<div
				style={{
					display: "flex",
					flexGrow: 1,
					alignItems: "center",
					gap: 48,
				}}
			>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						flexGrow: 1,
						flexShrink: 1,
						minWidth: 0,
						gap: 20,
					}}
				>
					<span
						style={{
							display: "block",
							fontSize: 56,
							fontWeight: 700,
							color: "white",
							lineHeight: 1.12,
							letterSpacing: -1,
							lineClamp: 3,
						}}
					>
						{heading}
					</span>
					<span
						style={{
							display: "block",
							fontSize: 26,
							fontWeight: 400,
							color: "rgba(255,255,255,0.92)",
							lineHeight: 1.4,
							lineClamp: 2,
						}}
					>
						{subline}
					</span>
				</div>
				<div style={{ display: "flex", flexShrink: 0 }}>
					<VideoCard width={520} fill={fill} />
				</div>
			</div>
		</div>
	</SkyBackground>
);

export async function renderVideoOg(variant: VideoOgVariant) {
	const element = (() => {
		switch (variant.kind) {
			case "video":
				return videoLayout(variant.video);
			case "locked":
				return statusLayout({
					heading: "This Cap is private",
					subline: "Ask the owner for access, or sign in to watch it on Cap.",
					fill: "lock",
				});
			case "password":
				return statusLayout({
					heading: "This Cap is password protected",
					subline: "Enter the password on Cap to watch this recording.",
					fill: "lock",
				});
			case "not-found":
				return statusLayout({
					heading: "This Cap doesn't exist",
					subline: "The recording you're looking for has moved or was deleted.",
					fill: "logo",
				});
		}
	})();

	return new ImageResponse(element, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: await loadOgFonts(),
		headers: {
			"Cache-Control": VIDEO_OG_CACHE_CONTROL,
			"X-Robots-Tag": "noindex",
		},
	});
}
