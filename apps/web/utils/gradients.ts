export const generateGradientFromColors = (
	colors: string[],
	angle?: number,
): string => {
	const gradientAngle = angle ?? 135;
	return `linear-gradient(${gradientAngle}deg, ${colors.join(", ")})`;
};

export const generateGradientFromSlug = (
	slug: string,
	customColors?: string[],
): string => {
	if (customColors && customColors.length > 0) {
		return generateGradientFromColors(customColors, 135);
	}

	let hash = 0;
	for (let i = 0; i < slug.length; i++) {
		const char = slug.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}

	const pastelColors = [
		["#fef3f2", "#fee2d5", "#fed7d7"], // soft reds/pinks
		["#f0f9ff", "#e0f2fe", "#dbeafe"], // soft blues
		["#f0fdf4", "#dcfce7", "#d1fae5"], // soft greens
		["#fffbeb", "#fef3c7", "#fed7aa"], // soft yellows/oranges
		["#fdf4ff", "#fae8ff", "#f3e8ff"], // soft purples
		["#f5f5f5", "#e5e7eb", "#d1d5db"], // soft grays
		["#fff7ed", "#ffedd5", "#fed7aa"], // soft peach
		["#f0fdfa", "#ccfbf1", "#a7f3d0"], // soft teals
	];

	const colorIndex = Math.abs(hash) % pastelColors.length;
	const colorSet = pastelColors[colorIndex] ??
		pastelColors[0] ?? ["#f0f9ff", "#e0f2fe", "#dbeafe"];

	const angle = Math.abs(hash) % 360;
	return `linear-gradient(${angle}deg, ${colorSet[0]}, ${colorSet[1]}, ${colorSet[2]})`;
};
