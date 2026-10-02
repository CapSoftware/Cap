"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type ComponentProps,
	type FocusEvent,
	forwardRef,
	type PointerEvent,
	useRef,
} from "react";

type HoverPrefetchLinkProps = Omit<ComponentProps<typeof Link>, "prefetch"> & {
	href: string;
};

/**
 * A link whose route is prefetched when it's pointed at or focused rather than
 * when it scrolls into view. For links off a page where the first load
 * matters more than an instant click, like the share page's way back into the
 * dashboard.
 */
export const HoverPrefetchLink = forwardRef<
	HTMLAnchorElement,
	HoverPrefetchLinkProps
>(function HoverPrefetchLink({ href, onPointerEnter, onFocus, ...props }, ref) {
	const router = useRouter();
	const prefetched = useRef(false);
	const prefetch = () => {
		if (prefetched.current) return;
		prefetched.current = true;
		router.prefetch(href);
	};
	return (
		<Link
			ref={ref}
			href={href}
			prefetch={false}
			onPointerEnter={(event: PointerEvent<HTMLAnchorElement>) => {
				prefetch();
				onPointerEnter?.(event);
			}}
			onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
				prefetch();
				onFocus?.(event);
			}}
			{...props}
		/>
	);
});
