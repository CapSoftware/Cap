import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";

const encodeKeySegment = (segment: string) =>
	encodeURIComponent(segment).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

export const getCloudFrontObjectUrl = (bucketUrl: string, key: string) =>
	`${bucketUrl}/${key.split("/").map(encodeKeySegment).join("/")}`;

export const createCloudFrontSignedUrl = ({
	bucketUrl,
	key,
	keyPairId,
	privateKey,
	expiresAt,
}: {
	bucketUrl: string;
	key: string;
	keyPairId: string;
	privateKey: string;
	expiresAt: number;
}) => {
	const policy = {
		Statement: [
			{
				Resource: getCloudFrontObjectUrl(bucketUrl, key),
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
