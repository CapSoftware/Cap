export function getArrowHeadSize(strokeWidth: number) {
	const width = Math.max(1, strokeWidth);
	const length = Math.max(20, width * 6);
	const headWidth = Math.max(14, width * 5);
	return { length, width: headWidth };
}

export function getArrowHeadPoints(
	endX: number,
	endY: number,
	angle: number,
	strokeWidth: number,
) {
	const { length, width } = getArrowHeadSize(strokeWidth);
	const baseX = endX - length * Math.cos(angle);
	const baseY = endY - length * Math.sin(angle);
	const offsetX = (width / 2) * Math.sin(angle);
	const offsetY = (width / 2) * -Math.cos(angle);

	return {
		base: { x: baseX, y: baseY },
		length,
		width,
		points: [
			{ x: endX, y: endY },
			{ x: baseX + offsetX, y: baseY + offsetY },
			{ x: baseX - offsetX, y: baseY - offsetY },
		],
	};
}
