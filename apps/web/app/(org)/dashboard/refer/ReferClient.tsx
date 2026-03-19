"use client";

interface ReferClientProps {
	token: string;
}

export default function ReferClient({ token }: ReferClientProps) {
	return (
		<iframe
			src={`https://app.dub.co/embed/referrals?token=${token}`}
			allow="clipboard-write"
			className="h-[calc(100vh-200px)] w-full rounded-lg border-0"
		/>
	);
}
