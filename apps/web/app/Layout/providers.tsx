"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { SessionProvider as NASessionProvider } from "next-auth/react";
import { type PropsWithChildren, useState } from "react";

// Development only: a static import would ship the devtools' Solid runtime
// to every page in production.
const Devtools =
	process.env.NODE_ENV === "development"
		? dynamic(() => import("./devtools").then((module) => module.Devtools), {
				ssr: false,
			})
		: () => null;

export function ReactQueryProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [queryClient] = useState(() => new QueryClient());

	return (
		<QueryClientProvider client={queryClient}>
			{children}
			{process.env.NODE_ENV === "development" ? <Devtools /> : null}
		</QueryClientProvider>
	);
}

export function SessionProvider({ children }: PropsWithChildren) {
	return <NASessionProvider>{children}</NASessionProvider>;
}
