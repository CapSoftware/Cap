import clsx from "clsx";

export function AppIcon({
	src,
	name,
	size = 44,
	className,
}: {
	src: string;
	name: string;
	size?: number;
	className?: string;
}) {
	return (
		<img
			src={src}
			alt={`${name} icon`}
			width={size}
			height={size}
			loading="lazy"
			decoding="async"
			className={clsx(
				"shrink-0 rounded-[22%] border border-gray-3 bg-gray-2 object-cover",
				className,
			)}
			style={{ width: size, height: size }}
		/>
	);
}
