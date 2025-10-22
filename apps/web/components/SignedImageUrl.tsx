"use client";

import { Avatar } from "@cap/ui";
import { useSignedImageUrl } from "@/lib/use-signed-image-url";

interface SignedImageUrlProps {
	image: string | null | undefined;
	name: string;
	type: "user" | "organization";
	className?: string;
	letterClass?: string;
	noFallback?: boolean;
}

/**
 * Component that handles both S3 keys (via RPC) and direct URLs
 * For S3 keys, it uses the RPC hook to get signed URLs
 * For direct URLs, it uses them as-is
 */
export function SignedImageUrl({
	image,
	name,
	type,
	className,
	letterClass,
}: SignedImageUrlProps) {
	const { data: signedUrl, isLoading } = useSignedImageUrl(image, type);

	function isS3Key(imageKeyOrUrl: string | null | undefined): boolean {
		if (!imageKeyOrUrl) return false;
		return (
			imageKeyOrUrl.startsWith("users/") ||
			imageKeyOrUrl.startsWith("organizations/")
		);
	}

	// If it's an S3 key, use the signed URL from RPC
	// If it's a direct URL, use it as-is
	const imageUrl = isS3Key(image) ? (signedUrl as string | null) : image;

	if (isS3Key(image) && isLoading) {
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
