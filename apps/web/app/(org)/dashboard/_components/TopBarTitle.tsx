"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";

export const TOP_BAR_TITLE_SLOT_ID = "dashboard-top-bar-title";

type TopBarTitleWidth = {
	width: number;
	setWidth: (width: number) => void;
};

const TopBarTitleWidthContext = createContext<TopBarTitleWidth>({
	width: 0,
	setWidth: () => {},
});

export function TopBarTitleProvider({ children }: { children: ReactNode }) {
	const [width, setWidth] = useState(0);
	const value = useMemo(() => ({ width, setWidth }), [width]);
	return (
		<TopBarTitleWidthContext.Provider value={value}>
			{children}
		</TopBarTitleWidthContext.Provider>
	);
}

export const useTopBarTitleWidth = () => useContext(TopBarTitleWidthContext);

export function TopBarTitle({ children }: { children: ReactNode }) {
	const [slot, setSlot] = useState<HTMLElement | null>(null);

	useEffect(() => {
		setSlot(document.getElementById(TOP_BAR_TITLE_SLOT_ID));
	}, []);

	return slot ? createPortal(children, slot) : null;
}

export function TopBarCrumbSeparator() {
	return (
		<span aria-hidden className="px-1.5 text-gray-8 shrink-0">
			/
		</span>
	);
}
