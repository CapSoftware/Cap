import { buildEnv, serverEnv } from "@cap/env";
import { STRIPE_PLAN_IDS } from "@cap/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type PropsWithChildren, Suspense } from "react";
import { SonnerToaster } from "@/components/SonnerToastProvider";
import { runPromise } from "@/lib/server";
import { PublicEnvContext } from "@/utils/public-env";
import { AuthContextProvider } from "./AuthContext";
import { resolveCurrentUser } from "./current-user";
import { PurchaseTracker } from "./PurchaseTracker";
import { ReactQueryProvider, SessionProvider } from "./providers";
import { SignupAnalytics } from "./SignupAnalytics";
import { StripeContextProvider } from "./StripeContext";

export async function AppProviders({ children }: PropsWithChildren) {
	const plans =
		serverEnv().VERCEL_ENV === "production"
			? STRIPE_PLAN_IDS.production
			: STRIPE_PLAN_IDS.development;

	return (
		<TooltipPrimitive.Provider>
			<AuthContextProvider user={runPromise(resolveCurrentUser)}>
				<SessionProvider>
					<StripeContextProvider plans={plans}>
						<PublicEnvContext
							value={{
								webUrl: buildEnv.NEXT_PUBLIC_WEB_URL,
								workosAuthAvailable: !!serverEnv().WORKOS_CLIENT_ID,
								googleAuthAvailable: !!serverEnv().GOOGLE_CLIENT_ID,
							}}
						>
							<ReactQueryProvider>
								<SonnerToaster />
								{children}
								<SignupAnalytics />
								<Suspense fallback={null}>
									<PurchaseTracker />
								</Suspense>
							</ReactQueryProvider>
						</PublicEnvContext>
					</StripeContextProvider>
				</SessionProvider>
			</AuthContextProvider>
		</TooltipPrimitive.Provider>
	);
}
