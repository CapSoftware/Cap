"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { DeveloperApp } from "./developer-data";

type DevelopersContextType = {
	apps: DeveloperApp[];
};

const DevelopersContext = createContext<DevelopersContextType>({
	apps: [],
});

export const useDevelopersContext = () => useContext(DevelopersContext);

export function DevelopersProvider({
	children,
	apps,
}: {
	children: ReactNode;
	apps: DeveloperApp[];
}) {
	return (
		<DevelopersContext.Provider value={{ apps }}>
			{children}
		</DevelopersContext.Provider>
	);
}
