"use client";

import { classNames } from "@cap/utils/helpers";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const SLIDE_MS = 560;
const DOCK_AT = 80;

type Phase = "docked" | "entering" | "floating" | "leaving";

const readSentinel = () => document.querySelector("[data-header-sentinel]");
const noSentinel = () => null;

// The page declares the flat treatment with `data-header-flat` on its root, a
// sibling of this header, and `:has(~ ...)` applies it in the prerendered HTML.
// The island is driven by the page's `data-header-sentinel`, re-read whenever
// the sibling page changes. Neither depends on `usePathname()`: Next prerenders
// `/` with pathname `/index`, so a route-keyed header rendered the fixed bar on
// the server and React kept those attributes after hydration.
export const NavbarFrame = ({ children }: { children: ReactNode }) => {
	const headerRef = useRef<HTMLElement>(null);
	const [phase, setPhase] = useState<Phase>("docked");

	const subscribeToPage = useCallback((onChange: () => void) => {
		const slot = headerRef.current?.parentElement;
		if (!slot) return () => {};
		const observer = new MutationObserver(onChange);
		observer.observe(slot, { childList: true });
		return () => observer.disconnect();
	}, []);
	const sentinel = useSyncExternalStore(
		subscribeToPage,
		readSentinel,
		noSentinel,
	);

	useLayoutEffect(() => {
		if (!sentinel) {
			setPhase("docked");
			return;
		}
		const io = new IntersectionObserver(([entry]) => {
			const past = entry
				? !entry.isIntersecting && entry.boundingClientRect.top < 0
				: false;
			setPhase((current) => {
				if (past) {
					return current === "floating" || current === "entering"
						? current
						: "entering";
				}
				return current === "docked" || current === "leaving"
					? current
					: "leaving";
			});
		});
		io.observe(sentinel);
		return () => io.disconnect();
	}, [sentinel]);

	useEffect(() => {
		if (phase === "entering") {
			let inner = 0;
			const outer = requestAnimationFrame(() => {
				inner = requestAnimationFrame(() => setPhase("floating"));
			});
			return () => {
				cancelAnimationFrame(outer);
				cancelAnimationFrame(inner);
			};
		}
		if (phase === "leaving") {
			const dockIfAtTop = () => {
				if (window.scrollY < DOCK_AT) setPhase("docked");
			};
			dockIfAtTop();
			window.addEventListener("scroll", dockIfAtTop, { passive: true });
			const timer = setTimeout(() => setPhase("docked"), SLIDE_MS);
			return () => {
				window.removeEventListener("scroll", dockIfAtTop);
				clearTimeout(timer);
			};
		}
	}, [phase]);

	const island = sentinel !== null && phase !== "docked";
	const shown = phase === "floating";

	return (
		<header
			ref={headerRef}
			data-island={island ? "true" : "false"}
			className={classNames(
				"group pointer-events-none inset-x-0 top-0 z-[51] fixed",
				!island && "has-[~[data-header-flat]]:absolute",
			)}
		>
			<div
				className={classNames(
					"pointer-events-auto mx-auto",
					!island &&
						"border-b border-zinc-200/70 bg-white group-has-[~[data-header-flat]]:border-b-0 group-has-[~[data-header-flat]]:bg-transparent",
					island &&
						"mt-3 max-w-[calc(100%-24px)] rounded-[18px] bg-white/90 shadow-[0_0_0_1px_rgba(17,17,17,0.06)] backdrop-blur-xl lg:mt-4 lg:max-w-[min(1200px,calc(100%-32px))]",
				)}
				style={
					island
						? {
								transform: shown
									? "translateY(0)"
									: "translateY(calc(-100% - 24px))",
								transition:
									phase === "entering"
										? "none"
										: `transform ${SLIDE_MS}ms ${EASE}`,
							}
						: undefined
				}
			>
				{children}
			</div>
		</header>
	);
};
