import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { PRICING } from "@/data/pricing";
import { loadOgAssets } from "@/lib/og/assets";
import { loadOgFonts } from "@/lib/og/fonts";
import { verifyOgSignature } from "@/lib/og/signature";
import {
	Body,
	CapWordmark,
	DesktopArt,
	Headline,
	OG_HEIGHT,
	OG_WIDTH,
	OgCanvas,
	PricingArt,
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

	const [fonts, assets] = await Promise.all([loadOgFonts(), loadOgAssets()]);
	const body = description ?? (isDefault ? DEFAULT_DESCRIPTION : undefined);
	const art =
		tag === "Pricing" ? (
			<div
				style={{ display: "flex", position: "absolute", left: 660, top: 96 }}
			>
				<PricingArt
					mesh={assets.mesh}
					pro={{
						monthly: PRICING.pro.monthly,
						annualPerMonth: PRICING.pro.annualPerMonth,
						savePercent: Math.round(
							(1 - PRICING.pro.annualPerMonth / PRICING.pro.monthly) * 100,
						),
					}}
				/>
			</div>
		) : (
			<div
				style={{ display: "flex", position: "absolute", left: 668, top: 112 }}
			>
				<DesktopArt mesh={assets.mesh} wallpaper={assets.wallpaper} />
			</div>
		);

	return new ImageResponse(
		<OgCanvas background={assets.skySplit}>
			{art}
			<div
				style={{
					display: "flex",
					position: "absolute",
					top: 0,
					left: 0,
					width: 620,
					height: "100%",
					padding: "58px 0 54px 64px",
					flexDirection: "column",
					justifyContent: "space-between",
				}}
			>
				<CapWordmark />
				<div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
					<Headline size={titleFontSize(title)} lines={4}>
						{title}
					</Headline>
					{body && (
						<Body size={25} lines={title.length > 30 ? 2 : 3}>
							{body}
						</Body>
					)}
				</div>
				<div style={{ display: "flex", height: 52 }} />
			</div>
		</OgCanvas>,
		{
			width: OG_WIDTH,
			height: OG_HEIGHT,
			fonts,
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
