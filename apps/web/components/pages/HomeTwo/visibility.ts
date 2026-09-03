"use client";

import {
	type RefObject,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";

const subscribeToVisibility = (notify: () => void) => {
	document.addEventListener("visibilitychange", notify);
	return () => document.removeEventListener("visibilitychange", notify);
};

const pageVisible = () => document.visibilityState !== "hidden";
const initiallyVisible = () => true;

export const usePageVisible = () =>
	useSyncExternalStore(subscribeToVisibility, pageVisible, initiallyVisible);

export const useInView = (
	ref: RefObject<Element | null>,
	margin = "-10% 0px -10% 0px",
) => {
	const [inView, setInView] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const io = new IntersectionObserver(
			([entry]) => setInView(Boolean(entry?.isIntersecting)),
			{ rootMargin: margin },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [ref, margin]);
	return inView;
};

export const useReducedMotion = () => {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const sync = () => setReduced(query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);
	return reduced;
};
