"use client";

import { createContext, useContext } from "react";

const SceneMediaContext = createContext<{ still: boolean }>({ still: false });

export const SceneMediaProvider = SceneMediaContext.Provider;

export const useSceneMedia = () => useContext(SceneMediaContext);

export const PRESENTER = {
	av1: "/videos/landing/presenter.webm",
	mp4: "/videos/landing/presenter.mp4",
	poster: "/videos/landing/presenter-poster.webp",
	avatar: "/videos/landing/presenter-avatar.webp",
} as const;

export const PresenterSources = () => (
	<>
		<source src={PRESENTER.av1} type='video/webm; codecs="av01.0.05M.08"' />
		<source src={PRESENTER.mp4} type="video/mp4" />
	</>
);

export const VIDEO_POSTERS = {
	webcam: PRESENTER.poster,
	screen: "/illustrations/homepage-animation-poster.jpg",
} as const;

export const useVideoAttrs = (poster: string, visible = true) => {
	const { still } = useSceneMedia();
	return { poster, preload: still || !visible ? "none" : "metadata" } as const;
};
