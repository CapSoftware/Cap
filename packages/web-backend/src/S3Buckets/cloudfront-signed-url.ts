import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";
import type { DateInput, RequestPresigningArguments } from "@smithy/types";

const DEFAULT_EXPIRES_SECONDS = 3600;

// Reads a signing date the way the S3 presigner does: a number, or a string
// holding one, is seconds since the epoch.
const epochMs = (date: DateInput) => {
	if (date instanceof Date) return date.getTime();
	const seconds = Number(date);
	return Number.isFinite(seconds) ? seconds * 1000 : new Date(date).getTime();
};

export const cloudFrontExpiresAt = (
	signingArgs:
		| Pick<RequestPresigningArguments, "expiresIn" | "signingDate">
		| undefined,
	now: number,
) => {
	const expiresIn = signingArgs?.expiresIn ?? DEFAULT_EXPIRES_SECONDS;
	const given =
		signingArgs?.signingDate === undefined
			? now
			: epochMs(signingArgs.signingDate);
	const signedAt = Number.isFinite(given) ? given : now;
	return Math.floor((signedAt + expiresIn * 1000) / 1000);
};

const encodeKeySegment = (segment: string) =>
	encodeURIComponent(segment).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

export const getCloudFrontObjectUrl = (bucketUrl: string, key: string) =>
	`${bucketUrl}/${key.split("/").map(encodeKeySegment).join("/")}`;

const getCloudFrontResourceUrl = (
	bucketUrl: string,
	key: string,
	responseContentDisposition: string | undefined,
) => {
	if (responseContentDisposition === undefined)
		return getCloudFrontObjectUrl(bucketUrl, key);
	// The distribution's /dl/* behaviour keys its cache on
	// response-content-disposition and strips /dl before reaching the bucket.
	const downloadUrl = getCloudFrontObjectUrl(`${bucketUrl}/dl`, key);
	return `${downloadUrl}?response-content-disposition=${encodeKeySegment(responseContentDisposition)}`;
};

export const isCloudFrontSignedUrl = (url: string) => {
	try {
		const query = new URL(url).searchParams;
		return query.has("Key-Pair-Id") && query.has("Signature");
	} catch {
		return false;
	}
};

export const createCloudFrontSignedUrl = ({
	bucketUrl,
	key,
	keyPairId,
	privateKey,
	expiresAt,
	responseContentDisposition,
}: {
	bucketUrl: string;
	key: string;
	keyPairId: string;
	privateKey: string;
	expiresAt: number;
	responseContentDisposition?: string;
}) => {
	const policy = {
		Statement: [
			{
				Resource: getCloudFrontResourceUrl(
					bucketUrl,
					key,
					responseContentDisposition,
				),
				Condition: {
					DateLessThan: {
						"AWS:EpochTime": expiresAt,
					},
				},
			},
		],
	};

	// No `url` here on purpose: the signer re-encodes `url` with
	// encodeURIComponent(decodeURIComponent(segment)), which turns %2A back into
	// a literal `*`. Without `url` it uses the policy Resource verbatim, so the
	// returned URL matches the signed Resource byte for byte, and CloudFront
	// compares against the raw request URL.
	return CloudFrontPresigner.getSignedUrl({
		keyPairId,
		privateKey,
		policy: JSON.stringify(policy),
	});
};
