import { type ComponentPropsWithoutRef, forwardRef } from "react";

export const BRAND_AVATAR_PATH = "/apple-touch-icon.png?v=shashank-face-2";

export const LogoBadge = forwardRef<
	HTMLImageElement,
	ComponentPropsWithoutRef<"img">
>(({ className, alt = "Shashank", src = BRAND_AVATAR_PATH, ...props }, ref) => {
	return (
		<img
			{...props}
			ref={ref}
			src={src}
			alt={alt}
			className={className}
			draggable={false}
		/>
	);
});

LogoBadge.displayName = "LogoBadge";
