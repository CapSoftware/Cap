import {
	forwardRouterTransitionStart,
	startClientSentry,
} from "@/lib/client-sentry";

startClientSentry();

export const onRouterTransitionStart = forwardRouterTransitionStart;
