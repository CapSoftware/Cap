import "@/app/globals.css";
import { getCurrentUser } from "@cap/database/auth/session";
import { buildEnv, serverEnv } from "@cap/env";
import { STRIPE_PLAN_IDS, userIsPro } from "@cap/utils";
import { ImageUploads } from "@cap/web-backend";
import type { ImageUpload } from "@cap/web-domain";
import { Analytics as DubAnalytics } from "@dub/analytics/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Effect } from "effect";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { PropsWithChildren } from "react";
import { SonnerToaster } from "@/components/SonnerToastProvider";
import { EffectRuntime } from "@/lib/EffectRuntime";
import { runPromise } from "@/lib/server";
import { getBootstrapData } from "@/utils/getBootstrapData";
import { PublicEnvContext } from "@/utils/public-env";
import { AuthContextProvider } from "./Layout/AuthContext";
import { resolveCurrentUser } from "./Layout/current-user";
import { GTag } from "./Layout/GTag";
import { MetaPixel } from "./Layout/MetaPixel";
import { PosthogIdentify } from "./Layout/PosthogIdentify";
import { PurchaseTracker } from "./Layout/PurchaseTracker";
import {
	PostHogProvider,
	ReactQueryProvider,
	SessionProvider,
} from "./Layout/providers";
import { StripeContextProvider } from "./Layout/StripeContext";
//@ts-expect-error
import { script } from "./themeScript";

const defaultFont = localFont({
	src: [
		{
			path: "../public/fonts/NeueMontreal-Bold.otf",
			weight: "700",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-Regular.otf",
			weight: "400",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-Medium.otf",
			weight: "500",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-MediumItalic.otf",
			weight: "500",
			style: "italic",
		},
		{
			path: "../public/fonts/NeueMontreal-Italic.otf",
			weight: "400",
			style: "italic",
		},
		{
			path: "../public/fonts/NeueMontreal-BoldItalic.otf",
			weight: "700",
			style: "italic",
		},
	],
});

export const metadata: Metadata = {
	title: "Cap — Beautiful screen recordings, owned by you.",
	description:
		"Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
	openGraph: {
		title: "Cap — Beautiful screen recordings, owned by you.",
		description:
			"Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
		type: "website",
		url: "https://cap.so",
		images: ["https://cap.so/og.png"],
	},
};

export const dynamic = "force-dynamic";

export default ({ children }: PropsWithChildren) =>
	Effect.gen(function* () {
		const bootstrapData = yield* Effect.promise(getBootstrapData);

		return (
			<html className={defaultFont.className} lang="en">
				<head>
					<link
						rel="apple-touch-icon"
						sizes="180x180"
						href="/apple-touch-icon.png"
					/>
					<link
						rel="icon"
						type="image/png"
						sizes="32x32"
						href="/favicon-32x32.png"
					/>
					<link
						rel="icon"
						type="image/png"
						sizes="16x16"
						href="/favicon-16x16.png"
					/>
					<link rel="manifest" href="/site.webmanifest" />
					<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#5bbad5" />
					<link rel="shortcut icon" href="/favicon.ico" />
					<meta name="msapplication-TileColor" content="#da532c" />
					<meta name="theme-color" content="#ffffff" />
				</head>
				<body suppressHydrationWarning>
					<script
						dangerouslySetInnerHTML={{ __html: `(${script.toString()})()` }}
					/>
					<TooltipPrimitive.Provider>
						<PostHogProvider bootstrapData={bootstrapData}>
							<AuthContextProvider user={runPromise(resolveCurrentUser)}>
								<SessionProvider>
									<StripeContextProvider
										plans={
											serverEnv().VERCEL_ENV === "production"
												? STRIPE_PLAN_IDS.production
												: STRIPE_PLAN_IDS.development
										}
									>
										<PublicEnvContext
											value={{
												webUrl: buildEnv.NEXT_PUBLIC_WEB_URL,
												workosAuthAvailable: !!serverEnv().WORKOS_CLIENT_ID,
												googleAuthAvailable: !!serverEnv().GOOGLE_CLIENT_ID,
											}}
										>
											<ReactQueryProvider>
												<SonnerToaster />
												<main className="w-full">{children}</main>
												<PosthogIdentify />
												<MetaPixel />
												<GTag />
												<PurchaseTracker />
											</ReactQueryProvider>
										</PublicEnvContext>
									</StripeContextProvider>
								</SessionProvider>
							</AuthContextProvider>
						</PostHogProvider>
					</TooltipPrimitive.Provider>
					{buildEnv.NEXT_PUBLIC_IS_CAP && (
						<DubAnalytics
							domainsConfig={{
								refer: "go.cap.so",
							}}
						/>
					)}
				</body>
			</html>
		);
	}).pipe(runPromise);
