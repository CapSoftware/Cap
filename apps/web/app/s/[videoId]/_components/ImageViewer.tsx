"use client";

import type { userSelectProps } from "@cap/database/auth/session";
import type { comments as commentsSchema, videos } from "@cap/database/schema";
import { LogoSpinner } from "@cap/ui";
import { MessageSquare } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Tooltip } from "react-tooltip";
import { ShareHeader } from "./ShareHeader";
import { Toolbar } from "./Toolbar";

// million-ignore
export const ImageViewer = ({
	data,
	user,
	comments,
	imageSrc,
}: {
	data: typeof videos.$inferSelect;
	user: typeof userSelectProps | null;
	comments: (typeof commentsSchema.$inferSelect)[];
	imageSrc: string;
}) => {
	const [overlayVisible, setOverlayVisible] = useState(false);
	const [imageLoaded, setImageLoaded] = useState(false);

	useEffect(() => {
		const img = new Image();
		img.src = imageSrc;
		img.onload = () => setImageLoaded(true);
	}, [imageSrc]);

	return (
		<div className="wrapper py-8">
			<div className="space-y-6">
				<ShareHeader data={data} user={user} />
				<div
					className="relative flex h-full w-full overflow-hidden shadow-lg rounded-lg group"
					id="player"
					onMouseEnter={() => setOverlayVisible(true)}
					onMouseLeave={() => setOverlayVisible(false)}
				>
					<div
						className="relative block w-full h-full rounded-lg bg-black"
						style={{ paddingBottom: "min(806px, 56.25%)" }}
					>
						{!imageLoaded && (
							<div className="absolute inset-0 flex items-center justify-center">
								<LogoSpinner className="w-8 md:w-12 h-auto animate-spin" />
							</div>
						)}
						<img
							src={imageSrc}
							alt="Image"
							className={`absolute top-0 left-0 rounded-lg w-full h-full object-contain transition-opacity duration-300 ${
								imageLoaded ? "opacity-100" : "opacity-0"
							}`}
							onLoad={() => setImageLoaded(true)}
						/>
						{comments.length > 0 && imageLoaded && (
							<div
								className={`absolute inset-0 bg-black transition-opacity duration-300 ${
									overlayVisible ? "opacity-50" : "opacity-0"
								}`}
							></div>
						)}
						{imageLoaded && (
							<div
								className={`absolute bottom-0 left-0 w-full transition-opacity duration-300 ${
									overlayVisible ? "opacity-100" : "opacity-0"
								}`}
							>
								<div className="flex justify-center items-center space-x-2 p-4">
									{comments.map((comment) => (
										<React.Fragment key={comment.id}>
											<div
												className="text-[16px] hover:scale-125 transition-all cursor-pointer"
												data-tooltip-id={comment.id}
											>
												<span>
													{comment.type === "text" ? (
														<MessageSquare
															fill="#646464"
															className="w-auto h-[22px] text-white"
														/>
													) : (
														comment.content
													)}
												</span>
											</div>
											<Tooltip
												id={comment.id}
												content={
													comment.type === "text"
														? `User: ${comment.content}`
														: comment.authorId === "anonymous"
															? "Anonymous"
															: "User"
												}
											/>
										</React.Fragment>
									))}
								</div>
							</div>
						)}
					</div>
				</div>
				<div className="flex justify-center">
					<Toolbar data={data} user={user} />
				</div>
			</div>
		</div>
	);
};
