"use client";

import { Avatar } from "@cap/ui";
import { isS3Key } from "@/lib/get-image-url";
import { useSignedImageUrl } from "@/lib/use-signed-image-url";

interface SignedImageUrlProps {
	imageKeyOrUrl: string | null | undefined;
	name: string;
	className?: string;
	letterClass?: string;
}

/**
 * Component that handles both S3 keys (via RPC) and direct URLs
 * For S3 keys, it uses the RPC hook to get signed URLs
 * For direct URLs, it uses them as-is
 */
export function SignedImageUrl({
	imageKeyOrUrl,
	name,
	className,
	letterClass,
}: SignedImageUrlProps) {
	const { data: signedUrl, isLoading } = useSignedImageUrl(imageKeyOrUrl);

	// If it's an S3 key, use the signed URL from RPC
	// If it's a direct URL, use it as-is
	const imageUrl = isS3Key(imageKeyOrUrl)
		? (signedUrl as string | null)
		: imageKeyOrUrl;

	if (isS3Key(imageKeyOrUrl) && isLoading) {
		return (
			<div
				className={className}
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: "var(--gray-5)",
					borderRadius: "50%",
				}}
			/>
		);
	}

	return (
		<Avatar
			name={name}
			imageUrl={imageUrl ?? undefined}
			className={className}
			letterClass={letterClass}
		/>
	);
}
