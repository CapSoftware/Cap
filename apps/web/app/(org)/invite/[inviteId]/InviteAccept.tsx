"use client";

import type { userSelectProps } from "@inflight/database/auth/session";
import { Button, Logo } from "@inflight/ui";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { toast } from "sonner";

type InviteAcceptProps = {
	inviteId: string;
	organizationName: string;
	inviterName: string;
	user: typeof userSelectProps | null;
};

export function InviteAccept({
	inviteId,
	organizationName,
	inviterName,
	user,
}: InviteAcceptProps) {
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(false);

	const handleAccept = async () => {
		setIsLoading(true);
		try {
			if (!user) {
				// Redirect to sign in page with a return URL
				router.push(`/login?next=/invite/${inviteId}`);
				return;
			}

			const response = await fetch("/api/invite/accept", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ inviteId }),
			});

			if (response.ok) {
				toast.success("Invite accepted successfully");
				router.push("/dashboard"); // Redirect to dashboard or appropriate page
			} else {
				const error = await response.text();
				toast.error(`Failed to accept invite: ${error}`);
			}
		} catch (error) {
			console.error("Error accepting invite:", error);
			toast.error("An error occurred while accepting the invite");
		} finally {
			setIsLoading(false);
		}
	};

	const handleDecline = async () => {
		setIsLoading(true);
		try {
			const response = await fetch("/api/invite/decline", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ inviteId }),
			});

			if (response.ok) {
				toast.success("Invite declined");
				router.push("/"); // Redirect to homepage
			} else {
				const error = await response.text();
				toast.error(`Failed to decline invite: ${error}`);
			}
		} catch (error) {
			console.error("Error declining invite:", error);
			toast.error("An error occurred while declining the invite");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<div className="flex flex-col items-center justify-center min-h-screen bg-gray-1 relative">
			<div className="bg-gray-50 p-4 rounded-[20px] border-[1px] border-gray-200 shadow-[0px 8px 16px rgba(18, 22, 31, 0.04)]">
				<Logo className="w-20 h-auto mb-4" />
				<h1 className="text-xl mb-4">
					You're invited to join <strong>{organizationName}</strong> on Cap
				</h1>
				<p className="text-gray-600 text-sm mb-6">
					{inviterName} invited you to join their organization on Cap.
				</p>
				<div className="flex space-x-2">
					<Button onClick={handleAccept} variant="primary" disabled={isLoading}>
						{isLoading ? "Processing..." : "Accept"}
					</Button>
					<Button onClick={handleDecline} variant="gray" disabled={isLoading}>
						{isLoading ? "Processing..." : "Decline"}
					</Button>
				</div>
			</div>
			{!user && (
				<Button
					onClick={() => signOut({ callbackUrl: "/login" })}
					size="sm"
					variant="white"
					className="absolute bottom-4 left-4 text-gray-1 hover:text-gray-700"
				>
					<LogOut className="w-4 h-4 mr-2" />
					Sign Out
				</Button>
			)}
		</div>
	);
}
