import { buildEnv } from "@cap/env";
import { SearchDoodle } from "@/components/paper-state/doodles";
import {
	PaperActions,
	PaperState,
	paperStateStyles as styles,
} from "@/components/paper-state/PaperState";

export default function VideoNotFound() {
	const homeHref = buildEnv.NEXT_PUBLIC_WEB_URL;

	return (
		<PaperState
			homeHref={homeHref}
			doodle={<SearchDoodle />}
			title="We couldn't find this video"
			lede="It may have been deleted, or the link is missing a few characters. Check the link with whoever sent it to you."
			footnote={
				<>
					Think this is a mistake? Email{" "}
					<a href="mailto:hello@cap.so">hello@cap.so</a>
				</>
			}
		>
			<PaperActions>
				<a className={styles.cta} href={homeHref}>
					Go to Cap
				</a>
			</PaperActions>
		</PaperState>
	);
}
