type VercelDeploymentEnvironment = {
	VERCEL_BRANCH_URL?: string;
	VERCEL_URL?: string;
};

export function getVercelDeploymentOrigins(
	env: VercelDeploymentEnvironment = {
		VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
		VERCEL_URL: process.env.VERCEL_URL,
	},
) {
	return Array.from(
		new Set(
			[env.VERCEL_URL, env.VERCEL_BRANCH_URL]
				.map((value) => value?.trim().toLowerCase())
				.map((hostname) => {
					if (!hostname?.endsWith(".vercel.app")) return undefined;
					try {
						const origin = new URL(`https://${hostname}`);
						return origin.hostname === hostname &&
							origin.origin === `https://${hostname}`
							? origin.origin
							: undefined;
					} catch {
						return undefined;
					}
				})
				.filter((origin): origin is string => Boolean(origin)),
		),
	);
}
