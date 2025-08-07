
import { Input } from "@cap/ui";
import clsx from "clsx";


interface DomainStepProps {
  domain: string;
  setDomain: (domain: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error?: string;
  onClearError: () => void;
}

export const DomainStep = ({ domain, setDomain, onSubmit, loading, error, onClearError }: DomainStepProps) => {
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDomain(e.target.value);
    if (error) {
      onClearError();
    }
  };

  return (
    <>
      <div className="space-y-6">
        <div className="text-center">
          <h3 className="text-lg font-semibold text-gray-12">Your domain</h3>
          <p className="text-sm text-gray-11">
            Enter the custom domain you'd like to use
          </p>
        </div>

        <div className="space-y-3">
          <Input
            type="text"
            id="customDomain"
            placeholder="your-domain.com"
            value={domain}
            className={clsx(
              "max-w-[400px] mx-auto",
              error && "border-red-500 focus:border-red-500"
            )}
            onChange={handleInputChange}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          />
          {error && (
            <p className="text-sm text-center text-red-500">{error}</p>
          )}
        </div>
      </div>
    </>
  );
};
