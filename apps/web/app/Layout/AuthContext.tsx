"use client";

import type { ImageUpload, User } from "@cap/web-domain";
import { createContext, use } from "react";

type CurrentUser = {
	id: User.UserId;
	email: string;
	name: string | null;
	imageUrl: ImageUpload.ImageUrl | null;
	isPro: boolean;
};

const AuthContext = createContext<
	{ user: Promise<CurrentUser | null> } | undefined
>(undefined);

export function AuthContextProvider({
	children,
	user,
}: {
	children: React.ReactNode;
	user: Promise<CurrentUser | null>;
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

export function useCurrentUser() {
	return use(useAuthContext().user);
}
