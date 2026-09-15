export function SsoErrorNotice({
	error,
}: {
	error: string | null | undefined;
}) {
	if (error === "SignupBlocked") {
		return (
			<div
				role="alert"
				className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900"
			>
				<h2 className="mb-2 font-semibold">
					Interested in Cap? We're open source.
				</h2>
				<p>
					If you're a competitor and interested in signing up to Cap, we're open
					source. I'm very flattered that you want to snoop around. Feel free to
					check out our codebase on{" "}
					<a
						className="font-semibold underline"
						href="https://github.com/CapSoftware/Cap"
						rel="noreferrer"
						target="_blank"
					>
						GitHub
					</a>
					, or{" "}
					<a className="font-semibold underline" href="mailto:richie@cap.so">
						message Richie
					</a>
					, the founder, directly.
				</p>
			</div>
		);
	}

	if (error !== "SsoMissingProfileAttributes") return null;

	return (
		<div
			role="alert"
			className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
		>
			<h2 className="mb-2 font-semibold">SSO profile details are missing</h2>
			<p>
				Your identity provider did not send all the profile details needed to
				sign in. Check that your profile includes your email, first name, and
				last name.
			</p>
			<p className="mt-2">
				If those are filled in, ask your IT administrator to check the required
				SSO attribute mapping. After correcting the profile or mapping, start
				SSO again.
			</p>
		</div>
	);
}
