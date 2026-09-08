/**
 * Official brand marks for the share targets.
 *
 * Inlined rather than served from `public/` so opening the share dialog costs
 * zero network requests, and so they inherit the surrounding size/colour
 * classes. Path data is the vendors' own artwork — the brand colours are
 * hard-coded on purpose (a recoloured Google "G" reads as broken, and every one
 * of these companies' brand guidelines forbids it). X is the exception: its
 * mark is monochrome, so it follows `currentColor` and survives dark mode.
 */

interface SocialIconProps {
	className?: string;
}

export const LinkedInIcon = ({ className }: SocialIconProps) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		aria-hidden="true"
		focusable="false"
		className={className}
	>
		<path
			fill="#0A66C2"
			d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"
		/>
	</svg>
);

export const XIcon = ({ className }: SocialIconProps) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 1200 1227"
		aria-hidden="true"
		focusable="false"
		className={className}
	>
		<path
			fill="currentColor"
			d="M714.163 519.284 1160.89 0h-105.86L667.137 450.887 357.328 0H0l468.492 681.821L0 1226.37h105.866l409.625-476.152 327.181 476.152H1200L714.137 519.284h.026zM569.165 687.828l-47.468-67.894-377.686-540.24h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026z"
		/>
	</svg>
);

export const FacebookIcon = ({ className }: SocialIconProps) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		aria-hidden="true"
		focusable="false"
		className={className}
	>
		<path
			fill="#1877F2"
			d="M24 12.073C24 5.446 18.627 0 12 0S0 5.446 0 12.073c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.469h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
		/>
	</svg>
);

/**
 * The Google "G" — four flat colours, no gradients. Used for the Gmail target
 * because Gmail's own mark is the envelope, and the "G" is what Google's own
 * "share to Gmail" surfaces use.
 */
export const GoogleIcon = ({ className }: SocialIconProps) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="-3 0 262 262"
		preserveAspectRatio="xMidYMid"
		aria-hidden="true"
		focusable="false"
		className={className}
	>
		<path
			fill="#4285F4"
			d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622 38.755 30.023 2.685.268c24.659-22.774 38.875-56.282 38.875-96.027"
		/>
		<path
			fill="#34A853"
			d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055-34.523 0-63.824-22.773-74.269-54.25l-1.531.13-40.298 31.187-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1"
		/>
		<path
			fill="#FBBC05"
			d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82 0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602l42.356-32.782"
		/>
		<path
			fill="#EB4335"
			d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0 79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251"
		/>
	</svg>
);
