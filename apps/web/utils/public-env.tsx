"use client";

import { createContext, type PropsWithChildren, useContext } from "react";

type PublicEnvContext = {
	webUrl: string;
	googleAuthAvailable: boolean;
	workosAuthAvailable: boolean;
	analyticsAvailable: boolean;
};

const Context = createContext<PublicEnvContext | null>(null);

export function PublicEnvContext(
	props: { value: PublicEnvContext } & PropsWithChildren,
) {
	return (
		<Context.Provider value={props.value}>{props.children}</Context.Provider>
	);
}

export function usePublicEnv() {
	const ctx = useContext(Context);
	if (!ctx)
		throw new Error("usePublicEnv must be used within a PublicEnvContext");
	return ctx;
}
