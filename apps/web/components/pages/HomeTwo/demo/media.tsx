"use client";

import { createContext, useContext } from "react";

const SceneMediaContext = createContext<{ still: boolean }>({ still: false });

export const SceneMediaProvider = SceneMediaContext.Provider;

export const useSceneMedia = () => useContext(SceneMediaContext);

export const VIDEO_POSTERS = {
	webcam: "/videos/home-two/webcam-poster.jpg",
	screen: "/illustrations/homepage-animation-poster.jpg",
} as const;

export const useVideoAttrs = (poster: string, visible = true) => {
	const { still } = useSceneMedia();
	return { poster, preload: still || !visible ? "none" : "metadata" } as const;
};
