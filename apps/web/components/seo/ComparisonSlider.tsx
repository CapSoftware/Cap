"use client";

import { motion } from "motion/react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

interface ComparisonSliderProps {
	leftImage: string;
	rightImage: string;
	leftAlt: string;
	rightAlt: string;
	leftLabel: string;
	rightLabel: string;
}

export const ComparisonSlider = ({
	leftImage,
	rightImage,
	leftAlt,
	rightAlt,
	leftLabel,
	rightLabel,
}: ComparisonSliderProps) => {
	const [sliderPosition, setSliderPosition] = useState(50);
	const [isDragging, setIsDragging] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const imageWidth = 1000;
	const imageHeight = 600;
	// Trigger re-render when container size changes
	const [, setContainerVersion] = useState(0);
	// Avoid initial overflow before measurements are ready
	const [ready, setReady] = useState(false);

	// Compute actual rendered image box inside the container based on object-contain
	const getImageMetrics = useCallback(() => {
		if (!containerRef.current) {
			return {
				containerWidth: 0,
				containerHeight: 0,
				imageDisplayWidth: imageWidth,
				imageDisplayHeight: imageHeight,
				imageStartX: 0,
				imageStartY: 0,
			};
		}
		const rect = containerRef.current.getBoundingClientRect();
		const containerWidth = rect.width;
		const containerHeight = rect.height;
		// object-contain: scale to fit container while preserving aspect ratio
		const scale = Math.min(
			containerWidth / imageWidth,
			containerHeight / imageHeight,
		);
		const imageDisplayWidth = imageWidth * scale;
		const imageDisplayHeight = imageHeight * scale;
		const imageStartX = (containerWidth - imageDisplayWidth) / 2;
		const imageStartY = (containerHeight - imageDisplayHeight) / 2;
		return {
			containerWidth,
			containerHeight,
			imageDisplayWidth,
			imageDisplayHeight,
			imageStartX,
			imageStartY,
		};
	}, []);

	// Mark ready after first layout pass to avoid initial overflow
	useEffect(() => {
		let rafId = 0;
		rafId = window.requestAnimationFrame(() => setReady(true));
		return () => window.cancelAnimationFrame(rafId);
	}, []);

	// Calculate handle position with constraints
	const getConstrainedHandlePosition = () => {
		if (!containerRef.current) return "50%";

		const { imageDisplayWidth, imageStartX } = getImageMetrics();
		const handlePosition =
			imageStartX + (sliderPosition / 100) * imageDisplayWidth;

		// Clamp handle position to image boundaries (use displayed width)
		const clampedPosition = Math.max(
			imageStartX,
			Math.min(imageStartX + imageDisplayWidth, handlePosition),
		);

		return `${clampedPosition}px`;
	};

	// Calculate clipping position with constraints
	const getConstrainedClipPosition = () => {
		if (!containerRef.current) return "50%";

		const { imageDisplayWidth, imageStartX } = getImageMetrics();
		const clipPosition =
			imageStartX + (sliderPosition / 100) * imageDisplayWidth;

		// Clamp clip position to image boundaries (use displayed width)
		const clampedPosition = Math.max(
			imageStartX,
			Math.min(imageStartX + imageDisplayWidth, clipPosition),
		);

		return `${clampedPosition}px`;
	};

	const handleMouseDown = useCallback(() => {
		setIsDragging(true);
	}, []);

	const handleMouseUp = useCallback(() => {
		setIsDragging(false);
		// Bounce back to center after dragging
		setTimeout(() => {
			setSliderPosition(50);
		}, 100);
	}, []);

	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (!isDragging || !containerRef.current) return;

			const rect = containerRef.current.getBoundingClientRect();
			const { imageDisplayWidth, imageStartX } = getImageMetrics();
			const imageEndX = imageStartX + imageDisplayWidth;

			const x = e.clientX - rect.left;

			// Only update if cursor is within image bounds
			if (x < imageStartX || x > imageEndX) return;

			const percentage = ((x - imageStartX) / imageDisplayWidth) * 100;
			const clampedPercentage = Math.max(0, Math.min(100, percentage));
			setSliderPosition(clampedPercentage);
		};

		const handleTouchMove = (e: TouchEvent) => {
			if (!isDragging || !containerRef.current) return;

			const rect = containerRef.current.getBoundingClientRect();
			const { imageDisplayWidth, imageStartX } = getImageMetrics();
			const imageEndX = imageStartX + imageDisplayWidth;

			const touch = e.touches[0];
			if (!touch) return;
			const x = touch.clientX - rect.left;

			// Only update if touch is within image bounds
			if (x < imageStartX || x > imageEndX) return;

			const percentage = ((x - imageStartX) / imageDisplayWidth) * 100;
			const clampedPercentage = Math.max(0, Math.min(100, percentage));
			setSliderPosition(clampedPercentage);
		};

		if (isDragging) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
			document.addEventListener("touchmove", handleTouchMove);
			document.addEventListener("touchend", handleMouseUp);
		}

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.removeEventListener("touchmove", handleTouchMove);
			document.removeEventListener("touchend", handleMouseUp);
		};
	}, [isDragging, handleMouseUp, getImageMetrics]);

	// Recompute metrics on container/window resize
	useEffect(() => {
		const handleWindowResize = () => setContainerVersion((v) => v + 1);

		let ro: ResizeObserver | undefined;
		if (typeof window !== "undefined") {
			window.addEventListener("resize", handleWindowResize);
			if (typeof ResizeObserver !== "undefined" && containerRef.current) {
				ro = new ResizeObserver(() => {
					setContainerVersion((v) => v + 1);
				});
				ro.observe(containerRef.current);
			}
		}

		return () => {
			window.removeEventListener("resize", handleWindowResize);
			if (ro && containerRef.current) ro.unobserve(containerRef.current);
			if (ro) ro.disconnect();
		};
	}, []);

	return (
		<div className="h-[400px] xs:h-[525px] sm:h-[600px] md:h-[700px] w-full max-w-[900px] mx-auto px-5">
			<div
				ref={containerRef}
				className="overflow-hidden relative w-full h-full rounded-xl select-none"
				style={{ userSelect: "none" }}
				aria-label="Click anywhere on the image to move the comparison slider"
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						const rect = containerRef.current?.getBoundingClientRect();
						if (rect) {
							setSliderPosition(50);
						}
					}
				}}
			>
				{/* Left Image (Base layer) */}
				<motion.div className="flex absolute inset-0 z-[5] justify-center items-center">
					<Image
						src={leftImage}
						alt={leftAlt}
						width={1000}
						height={600}
						quality={100}
						className="object-contain"
					/>
				</motion.div>

				{/* Right Image (Clipped overlay) */}
				<motion.div
					initial={{
						// Use percentage before measurements to avoid overflow
						clipPath: "inset(0 0 0 50%)",
					}}
					animate={{
						clipPath: `inset(0 0 0 ${ready ? getConstrainedClipPosition() : "50%"})`,
					}}
					transition={{
						duration: isDragging ? 0 : 0.3,
						ease: "easeOut",
						delay: 0.2,
						clipPath: {
							duration: isDragging ? 0 : 0.3,
						},
					}}
					className="flex overflow-hidden absolute inset-0 z-10 justify-center items-center"
				>
					<Image
						src={rightImage}
						alt={rightAlt}
						width={1000}
						height={600}
						quality={100}
						className="object-contain"
					/>

					{ready && (
						<motion.div
							className="pointer-events-none absolute z-[15]"
							initial={{ left: getConstrainedClipPosition() }}
							animate={{ left: getConstrainedClipPosition() }}
							transition={{ duration: isDragging ? 0 : 0.3 }}
							style={{
								top: `${getImageMetrics().imageStartY + getImageMetrics().imageDisplayHeight / 2}px`,
								height: `${getImageMetrics().imageDisplayHeight}px`,
								transform: "translate(-50%, -50%)",
							}}
						>
							<div className="w-0.5 h-full bg-gradient-to-b from-transparent via-gray-10 to-transparent shadow-sm" />
						</motion.div>
					)}
				</motion.div>

				{/* Slider Handle */}
				<motion.div
					className="flex absolute top-0 bottom-0 z-20 items-center"
					initial={{ left: getConstrainedHandlePosition() }}
					animate={{ left: getConstrainedHandlePosition() }}
					transition={{ duration: isDragging ? 0 : 0.3 }}
					style={{ transform: "translateX(-50%)" }}
					onMouseDown={handleMouseDown}
					onTouchStart={handleMouseDown}
				>
					<div className="relative">
						{/* Vertical Line */}
						<div className="w-0.5 h-full bg-white shadow-lg" />

						{/* Handle Bubble */}
						<div className="flex absolute top-1/2 scale-[0.8] sm:scale-100 left-1/2 gap-2 justify-center items-center px-3 py-1.5 rounded-full border shadow-lg transition-transform transform -translate-x-1/2 -translate-y-1/2 bg-gray-3 border-gray-6 min-w-fit cursor-grab hover:scale-110">
							<p className="text-sm text-gray-12">{leftLabel}</p>
							<p className="text-lg font-medium text-gray-12">vs</p>
							<p className="text-sm text-gray-12">{rightLabel}</p>
						</div>
					</div>
				</motion.div>
			</div>
		</div>
	);
};
