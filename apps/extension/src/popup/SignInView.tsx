import { Button, Logo } from "@cap/ui";

export const SignInView = ({
	onSignIn,
	isSigningIn,
}: {
	onSignIn: () => void;
	isSigningIn: boolean;
}) => {
	return (
		<div className="h-full w-full flex items-center justify-center p-4">
			<div className="w-full rounded-xl border border-gray-4 bg-gray-1 p-5">
				<div className="flex flex-col items-center gap-4">
					<Logo className="h-10 w-auto" />
					<div className="text-center">
						<div className="text-sm font-medium text-gray-12">
							Sign in to record with Cap
						</div>
						<div className="mt-1 text-xs text-gray-11">
							Complete sign in in the web app, then come back here.
						</div>
					</div>
					<Button
						type="button"
						variant="primary"
						size="md"
						className="w-full"
						onClick={onSignIn}
						disabled={isSigningIn}
						spinner={isSigningIn}
					>
						Sign in via Web
					</Button>
				</div>
			</div>
		</div>
	);
};
