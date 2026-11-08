"use client";

import { buildEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { signOut } from "next-auth/react";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import {
	EnvelopeDoodle,
	KeyDoodle,
	LockDoodle,
} from "@/components/paper-state/doodles";
import {
	PaperActions,
	PaperState,
	paperStateStyles as styles,
} from "@/components/paper-state/PaperState";

const accessUrls = (videoId: Video.VideoId) => {
	const next = encodeURIComponent(`/s/${videoId}`);
	return {
		login: `/login?next=${next}`,
		signup: `/signup?next=${next}`,
	};
};

function SwitchAccountButton({ loginUrl }: { loginUrl: string }) {
	return (
		<button
			type="button"
			className={styles.cta}
			onClick={() => signOut({ callbackUrl: loginUrl })}
		>
			Switch account
		</button>
	);
}

export function PrivateVideoState({ videoId }: { videoId: Video.VideoId }) {
	const user = useCurrentUser();
	const urls = accessUrls(videoId);

	if (user) {
		return (
			<PaperState
				homeHref={buildEnv.NEXT_PUBLIC_WEB_URL}
				doodle={<LockDoodle />}
				title="This video is private"
				lede={
					<>
						You're signed in as <strong>{user.email}</strong>, which doesn't
						have access. Switch to the account that was invited, or ask the
						owner to share it with you.
					</>
				}
			>
				<PaperActions>
					<SwitchAccountButton loginUrl={urls.login} />
					<a
						className={`${styles.cta} ${styles.ghost}`}
						href={`${buildEnv.NEXT_PUBLIC_WEB_URL}/dashboard`}
					>
						Go to my Caps
					</a>
				</PaperActions>
			</PaperState>
		);
	}

	return (
		<PaperState
			homeHref={buildEnv.NEXT_PUBLIC_WEB_URL}
			doodle={<LockDoodle />}
			title="This video is private"
			lede="Only people the owner invited can watch it. If that's you, sign in with the email address that was invited."
		>
			<PaperActions>
				<a className={styles.cta} href={urls.login}>
					Sign in
				</a>
				<a className={`${styles.cta} ${styles.ghost}`} href={urls.signup}>
					Create an account
				</a>
			</PaperActions>
		</PaperState>
	);
}

export function SignInRequiredState({ videoId }: { videoId: Video.VideoId }) {
	return (
		<PaperState
			homeHref={buildEnv.NEXT_PUBLIC_WEB_URL}
			doodle={<KeyDoodle />}
			title="Sign in to watch"
			lede="The owner only shares this video with approved email addresses. Sign in with yours to start watching."
		>
			<PaperActions>
				<a className={styles.cta} href={accessUrls(videoId).login}>
					Sign in
				</a>
			</PaperActions>
		</PaperState>
	);
}

export function AccessRestrictedState({ videoId }: { videoId: Video.VideoId }) {
	const user = useCurrentUser();

	return (
		<PaperState
			homeHref={buildEnv.NEXT_PUBLIC_WEB_URL}
			doodle={<EnvelopeDoodle />}
			title="This video is restricted"
			lede={
				user ? (
					<>
						<strong>{user.email}</strong> isn't on the list of addresses the
						owner allows. Try another account, or ask the owner for access.
					</>
				) : (
					"Your email address isn't on the list of addresses the owner allows. Try another account, or ask the owner for access."
				)
			}
		>
			<PaperActions>
				<SwitchAccountButton loginUrl={accessUrls(videoId).login} />
			</PaperActions>
		</PaperState>
	);
}
