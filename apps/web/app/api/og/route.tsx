import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { loadOgFonts } from "@/lib/og/fonts";
import { verifyOgSignature } from "@/lib/og/signature";
import {
	CapWordmark,
	OG_HEIGHT,
	OG_WIDTH,
	RecorderCard,
	SkyBackground,
	TagChip,
	titleFontSize,
} from "@/lib/og/template";

const DEFAULT_TITLE = "Beautiful screen recordings, owned by you";
const DEFAULT_DESCRIPTION =
	"The open source Loom alternative. Record and share in seconds.";

// Strip control characters and collapse whitespace so arbitrary query input
// can't distort the layout.
const clean = (value: string | null, maxLength: number) =>
	value
		?.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength) || undefined;

export async function GET(req: NextRequest) {
	const params = req.nextUrl.searchParams;

	// Only text our own server-side metadata helpers signed gets rendered;
	// anything else (or no params at all) serves the default brand image.
	const rawTitle = params.get("title");
	const isSigned =
		rawTitle !== null &&
		verifyOgSignature(
			{
				title: rawTitle,
				tag: params.get("tag") ?? undefined,
				description: params.get("description") ?? undefined,
			},
			params.get("s"),
		);

	const title = (isSigned && clean(rawTitle, 110)) || DEFAULT_TITLE;
	const tag = isSigned ? clean(params.get("tag"), 28) : undefined;
	const description = isSigned
		? clean(params.get("description"), title.length > 72 ? 0 : 150)
		: undefined;
	const isDefault = !isSigned;

	return new ImageResponse(
		<SkyBackground>
			<div
				style={{
					display: "flex",
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
					padding: "56px 64px",
					alignItems: "center",
					gap: 56,
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
					<CapWordmark height={60} />
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 22,
							paddingBottom: 8,
						}}
					>
						{tag && <TagChip label={tag} />}
						<span
							style={{
								display: "block",
								fontSize: titleFontSize(title),
								fontWeight: 700,
								color: "white",
								lineHeight: 1.1,
								letterSpacing: -1.5,
								lineClamp: 4,
							}}
						>
							{title}
						</span>
						{(description ?? (isDefault ? DEFAULT_DESCRIPTION : undefined)) && (
							<span
								style={{
									display: "block",
									fontSize: 27,
									fontWeight: 400,
									color: "rgba(255,255,255,0.92)",
									lineHeight: 1.4,
									lineClamp: 2,
								}}
							>
								{description ?? DEFAULT_DESCRIPTION}
							</span>
						)}
					</div>
					<span
						style={{
							fontSize: 24,
							fontWeight: 500,
							color: "rgba(255,255,255,0.85)",
						}}
					>
						Cap.so
					</span>
				</div>
				<div style={{ display: "flex", flexShrink: 0 }}>
					<RecorderCard width={384} />
				</div>
			</div>
		</SkyBackground>,
		{
			width: OG_WIDTH,
			height: OG_HEIGHT,
			fonts: await loadOgFonts(),
			headers: {
				// The image is a pure function of the URL, so it can be cached
				// forever — changed copy produces a different URL.
				"Cache-Control":
					"public, max-age=31536000, s-maxage=31536000, immutable",
				"X-Robots-Tag": "noindex",
			},
		},
	);
}
