import Hls from "hls.js";
import { forwardRef, memo, useEffect } from "react";

export const AudioPlayer = memo(
	forwardRef<HTMLAudioElement, { src: string; onReady: () => void }>(
		({ src, onReady }, ref) => {
			useEffect(() => {
				const audio = ref as React.MutableRefObject<HTMLAudioElement | null>;

				if (!audio.current) return;

				let hls: Hls | null = null;

				if (Hls.isSupported()) {
					hls = new Hls();
					hls.loadSource(src);
					hls.attachMedia(audio.current);
					hls.on(Hls.Events.MANIFEST_PARSED, () => {
						onReady();
					});
				} else if (audio.current.canPlayType("application/vnd.apple.mpegurl")) {
					audio.current.src = src;
					audio.current.addEventListener(
						"loadedmetadata",
						() => {
							onReady();
						},
						{ once: true },
					);
				}

				return () => {
					if (hls) {
						hls.destroy();
					}
				};
			}, [src, onReady, ref]);

			return <audio ref={ref} controls={false} style={{ display: "none" }} />;
		},
	),
);
