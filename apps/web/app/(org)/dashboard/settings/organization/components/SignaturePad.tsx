"use client";

import { Button } from "@cap/ui";
import { useEffect, useRef, useState } from "react";

const INK_COLOR = "#16181d";
const LINE_WIDTH = 2.25;
const EXPORT_PADDING = 12;

type Point = { x: number; y: number };

export function SignaturePad({
	onChange,
	disabled = false,
}: {
	onChange: (dataUrl: string | null) => void;
	disabled?: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const drawingRef = useRef(false);
	const lastPointRef = useRef<Point | null>(null);
	const lastMidRef = useRef<Point | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const [isEmpty, setIsEmpty] = useState(true);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const setup = () => {
			const dpr = window.devicePixelRatio || 1;
			const rect = canvas.getBoundingClientRect();
			const width = Math.max(1, Math.round(rect.width * dpr));
			const height = Math.max(1, Math.round(rect.height * dpr));
			if (canvas.width === width && canvas.height === height) return;
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.scale(dpr, dpr);
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.strokeStyle = INK_COLOR;
			ctx.fillStyle = INK_COLOR;
			ctx.lineWidth = LINE_WIDTH;
			setIsEmpty(true);
			onChangeRef.current(null);
		};

		setup();
		const observer = new ResizeObserver(setup);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, []);

	const getContext = () => canvasRef.current?.getContext("2d") ?? null;

	const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	};

	const exportSignature = () => {
		const canvas = canvasRef.current;
		const ctx = getContext();
		if (!canvas || !ctx) return;

		const { width, height } = canvas;
		const data = ctx.getImageData(0, 0, width, height).data;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (data[(y * width + x) * 4 + 3]) {
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
		}
		if (maxX < 0) {
			setIsEmpty(true);
			onChangeRef.current(null);
			return;
		}

		const cropWidth = maxX - minX + 1;
		const cropHeight = maxY - minY + 1;
		const output = document.createElement("canvas");
		output.width = cropWidth + EXPORT_PADDING * 2;
		output.height = cropHeight + EXPORT_PADDING * 2;
		const outputCtx = output.getContext("2d");
		if (!outputCtx) return;
		outputCtx.drawImage(
			canvas,
			minX,
			minY,
			cropWidth,
			cropHeight,
			EXPORT_PADDING,
			EXPORT_PADDING,
			cropWidth,
			cropHeight,
		);
		setIsEmpty(false);
		onChangeRef.current(output.toDataURL("image/png"));
	};

	const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (disabled) return;
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {}
		const ctx = getContext();
		if (!ctx) return;
		const point = pointFromEvent(e);
		drawingRef.current = true;
		lastPointRef.current = point;
		lastMidRef.current = point;
		ctx.beginPath();
		ctx.arc(point.x, point.y, LINE_WIDTH / 2, 0, Math.PI * 2);
		ctx.fill();
	};

	const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!drawingRef.current) return;
		const ctx = getContext();
		const last = lastPointRef.current;
		const lastMid = lastMidRef.current;
		if (!ctx || !last || !lastMid) return;
		const point = pointFromEvent(e);
		const mid = { x: (last.x + point.x) / 2, y: (last.y + point.y) / 2 };
		ctx.beginPath();
		ctx.moveTo(lastMid.x, lastMid.y);
		ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
		ctx.stroke();
		lastPointRef.current = point;
		lastMidRef.current = mid;
	};

	const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!drawingRef.current) return;
		drawingRef.current = false;
		lastPointRef.current = null;
		lastMidRef.current = null;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {}
		exportSignature();
	};

	const handleClear = () => {
		const canvas = canvasRef.current;
		const ctx = getContext();
		if (!canvas || !ctx) return;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.restore();
		setIsEmpty(true);
		onChangeRef.current(null);
	};

	return (
		<div className="relative shrink-0">
			<canvas
				ref={canvasRef}
				className="block w-full h-32 bg-white rounded-xl border cursor-crosshair border-gray-4 touch-none"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
			/>
			<span className="absolute bottom-[22px] left-4 text-xs text-gray-400 pointer-events-none select-none">
				✕
			</span>
			<div className="absolute right-5 left-9 bottom-7 border-b border-gray-300 pointer-events-none" />
			{isEmpty && (
				<span className="absolute inset-x-0 bottom-11 text-sm text-center text-gray-400 pointer-events-none select-none">
					Draw your signature here
				</span>
			)}
			{!isEmpty && (
				<Button
					type="button"
					variant="gray"
					size="xs"
					className="absolute top-2 right-2"
					onClick={handleClear}
					disabled={disabled}
				>
					Clear
				</Button>
			)}
		</div>
	);
}
