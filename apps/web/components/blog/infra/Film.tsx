import { buildEnv } from "@cap/env";
import { CapPlayer } from "@/components/cap-player/CapPlayer";
import { FILM, filmFiles } from "@/components/pages/infra/film-source";
import { FadeIn } from "../native/shared";

const FILES = filmFiles(buildEnv.NEXT_PUBLIC_INFRA_FILM_URL);

export function InfraFilm() {
	return (
		<FadeIn className="my-10 sm:my-12">
			<div className="overflow-hidden rounded-[12px] sm:rounded-[14px]">
				<CapPlayer
					source={FILES}
					title={FILM.title}
					poster={FILES.poster}
					aspectRatio={FILM.ratio}
				/>
			</div>
			<figcaption className="mt-4 text-pretty text-[13px] leading-[1.6] text-[rgba(232,236,244,0.46)]">
				This film is hosted on Cap Infra and plays in the same player you get
				with every video.
			</figcaption>
		</FadeIn>
	);
}
