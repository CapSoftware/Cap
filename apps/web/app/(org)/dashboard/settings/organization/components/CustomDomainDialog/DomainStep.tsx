import { Input } from "@cap/ui";
import clsx from "clsx";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";

interface DomainStepProps {
	domain: string;
	setDomain: (domain: string) => void;
	onSubmit: () => void;
	error?: string;
	submitLoading?: boolean;
	onClearError: () => void;
}

const DomainStep = ({
	domain,
	setDomain,
	onSubmit,
	error,
	onClearError,
	submitLoading,
}: DomainStepProps) => {
	const { user } = useDashboardContext();
	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setDomain(e.target.value);
		if (error) {
			onClearError();
		}
	};

	return (
		<div className="space-y-6">
			<div className="text-center">
				<h3 className="text-lg font-semibold text-gray-12">你的域名</h3>
				<p className="text-sm text-gray-11">
					输入你想使用的自定义域名，例如{" "}
					<span className="font-medium text-gray-12">caps.yourdomain.com</span>
				</p>
			</div>
			<div className="space-y-3">
				<Input
					type="text"
					id="customDomain"
					placeholder="caps.yourdomain.com"
					value={domain}
					disabled={!user.isPro || submitLoading}
					className={clsx(
						"max-w-[400px] mx-auto",
						error && "border-red-500 focus:border-red-500",
					)}
					onChange={handleInputChange}
					onKeyDown={(e) => e.key === "Enter" && onSubmit()}
				/>
				{error && <p className="text-sm text-center text-red-500">{error}</p>}
			</div>
		</div>
	);
};

export default DomainStep;
