type Point = {
	x: number;
	y: number;
};

type Size = {
	width: number;
	height: number;
};

type Rectangle = {
	position: Point;
	size: Size;
};

const clamp = (value: number, minimum: number, maximum: number) =>
	Math.min(Math.max(value, minimum), maximum);

export function getPostResizeWindowPosition(
	positionBeforeResize: Point,
	positionAfterResize: Point,
	windowSize: Size,
	workArea: Rectangle,
	padding: number,
) {
	const minimumX = workArea.position.x + padding;
	const minimumY = workArea.position.y + padding;
	const maximumX = Math.max(
		minimumX,
		workArea.position.x + workArea.size.width - windowSize.width - padding,
	);
	const maximumY = Math.max(
		minimumY,
		workArea.position.y + workArea.size.height - windowSize.height - padding,
	);
	const targetPosition = {
		x: clamp(positionBeforeResize.x, minimumX, maximumX),
		y: clamp(positionBeforeResize.y, minimumY, maximumY),
	};

	if (
		targetPosition.x === positionAfterResize.x &&
		targetPosition.y === positionAfterResize.y
	) {
		return null;
	}

	return targetPosition;
}
