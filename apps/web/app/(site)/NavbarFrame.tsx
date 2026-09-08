"use client";

import { classNames } from "@cap/utils/helpers";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

const FLAT_HEADER_ROUTES = new Set(["/", "/home"]);
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const SLIDE_MS = 560;
const DOCK_AT = 80;

type Phase = "docked" | "entering" | "floating" | "leaving";

export const NavbarFrame = ({ children }: { children: ReactNode }) => {
	const pathname = usePathname();
	const flat = FLAT_HEADER_ROUTES.has(pathname);
	const [phase, setPhase] = useState<Phase>("docked");

	useEffect(() => {
		if (!FLAT_HEADER_ROUTES.has(pathname)) return;
		const sentinel = document.querySelector("[data-header-sentinel]");
		if (!sentinel) return;
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
	}, [pathname]);

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

	const island = flat && phase !== "docked";
	const shown = phase === "floating";

	return (
		<header
			data-flat={flat ? "true" : "false"}
			data-island={island ? "true" : "false"}
			className={classNames(
				"group pointer-events-none inset-x-0 top-0 z-[51]",
				flat && !island ? "absolute" : "fixed",
			)}
		>
			<div
				className={classNames(
					"pointer-events-auto mx-auto",
					!flat && "max-w-none border-b border-zinc-200/70 bg-white",
					flat && !island && "bg-transparent",
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
