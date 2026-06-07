"use client";

import type { ImageUpload, Organisation, User } from "@cap/web-domain";
import { createContext, use } from "react";

export type CurrentUser = {
	id: User.UserId;
	email: string;
	name: string | null;
	lastName: string | null;
	imageUrl: ImageUpload.ImageUrl | null;
	defaultOrgId: Organisation.OrganisationId | null;
	isPro: boolean;
};

const AuthContext = createContext<
	{ user: Promise<CurrentUser | null> } | undefined
>(undefined);
const anonymousUser = Promise.resolve(null);

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
	const context = use(AuthContext);
	return use(context?.user ?? anonymousUser);
}
