"use client";

import type { getCurrentUser } from "@cap/database/auth/session";
import { createContext, use } from "react";

const AuthContext = createContext<
	{ user: ReturnType<typeof getCurrentUser> } | undefined
>(undefined);

export function AuthContextProvider({
	children,
	user,
}: {
	children: React.ReactNode;
	user: ReturnType<typeof getCurrentUser>;
}) {
	return (
		<AuthContext.Provider value={{ user }}>{children}</AuthContext.Provider>
	);
}

export function useAuthContext() {
	const context = use(AuthContext);
	if (!context) {
		throw new Error("useSiteContext must be used within a SiteContextProvider");
	}
	return context;
}
