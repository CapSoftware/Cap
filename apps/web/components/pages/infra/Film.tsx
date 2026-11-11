"use client";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { trackEvent } from "@/app/utils/analytics";
import { CapPlayer } from "@/components/cap-player/CapPlayer";
import { warmSource } from "@/components/cap-player/source";
import styles from "./film.module.css";
import { FILM, FILM_EVENT } from "./film-source";

const announce = (open: boolean) =>
	window.dispatchEvent(new CustomEvent(FILM_EVENT, { detail: open }));

const track = (event: "infra_film_opened" | "infra_film_completed") =>
	trackEvent(event, { source_page: "infra", cta_location: "hero" });

export const FilmButton = ({
	files,
}: {
	files: NonNullable<typeof FILM.files>;
}) => {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const warmed = useRef(false);
	const scroll = useRef("");
	const [open, setOpen] = useState(false);

	const warm = () => {
		if (warmed.current) return;
		warmed.current = true;
		warmSource(files);
		new Image().src = files.poster;
	};

	const show = () => {
		const dialog = dialogRef.current;
		if (!dialog || dialog.open) return;
		warm();
		scroll.current = document.documentElement.style.overflow;
		document.documentElement.style.overflow = "hidden";
		dialog.showModal();
		flushSync(() => setOpen(true));
		announce(true);
		track("infra_film_opened");
	};

	const closed = () => {
		setOpen(false);
		document.documentElement.style.overflow = scroll.current;
		announce(false);
	};

	const close = () => dialogRef.current?.close();

	return (
		<>
			<button
				type="button"
				className={styles.play}
				onClick={show}
				onPointerEnter={warm}
				onFocus={warm}
				aria-haspopup="dialog"
			>
				<svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
					<path d="M5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1L5.92 2.4a.6.6 0 0 0-.92.5Z" />
				</svg>
				Watch the film
			</button>
			<dialog
				ref={dialogRef}
				className={styles.dialog}
				aria-label={FILM.title}
				onClose={closed}
			>
				<button
					type="button"
					className={styles.away}
					onClick={close}
					tabIndex={-1}
					aria-hidden="true"
				/>
				<div className={styles.frame}>
					{open ? (
						<CapPlayer
							source={files}
							title={FILM.title}
							poster={files.poster}
							aspectRatio={FILM.ratio}
							autoPlay
							focusOnMount
							onEnded={() => track("infra_film_completed")}
						/>
					) : null}
				</div>
				<button
					type="button"
					className={styles.close}
					onClick={close}
					aria-label="Close the film"
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path
							d="m3.5 3.5 9 9m0-9-9 9"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
							strokeLinecap="round"
						/>
					</svg>
				</button>
			</dialog>
		</>
	);
};
