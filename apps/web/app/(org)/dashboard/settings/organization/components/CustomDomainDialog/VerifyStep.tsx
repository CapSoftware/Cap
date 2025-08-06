import {
  Button
} from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faRefresh } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import clsx from "clsx";
import { DomainConfig } from "./types";
import { Check, CheckCircle, Copy, XCircle } from "lucide-react";
import { toast } from "sonner";

interface VerifyStepProps {
  domain: string;
  domainConfig?: DomainConfig | null;
  isVerified?: boolean;
  onVerifyDomain?: () => Promise<void>;
  verifying?: boolean;
  onNext: () => void;
  onPrev: () => void;
}

export const VerifyStep = ({
  domain,
  domainConfig,
  isVerified,
  onVerifyDomain,
  verifying,
  onNext,
  onPrev
}: VerifyStepProps) => {
  const [copiedField, setCopiedField] = useState<"name" | "value" | null>(null);

  const handleCopy = async (text: string, field: "name" | "value") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
      toast.success("Copied to clipboard");
    } catch (err) {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleVerifyClick = async () => {
    if (onVerifyDomain) {
      await onVerifyDomain();
    }
  };

  console.log({
    domain,
    domainConfig,
  })

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-12">Verify your domain</h3>
        <p className="text-sm text-gray-11">
          Add the DNS records below to verify ownership of {domain}
        </p>
      </div>

      {/* Verification Status */}
      <div className="flex justify-center">
        {isVerified ? (
          <div className="flex gap-2 items-center px-3 py-2 text-sm text-white bg-green-600 rounded-full">
            <CheckCircle className="size-4" />
            <span className="text-sm font-medium text-white">Domain verified</span>
          </div>
        ) : (
          <div className="flex gap-2 items-center px-3 py-2 text-sm text-white bg-red-500 rounded-full">
            <XCircle className="size-4" />
            <span className="text-sm font-medium text-white">Domain not verified</span>
          </div>
        )}
      </div>

      {/* DNS Configuration */}
      {!isVerified && domainConfig && (
        <div className="space-y-4">
          {/* TXT Record Configuration */}
          {domainConfig.verification?.[0] && (
            <div className="overflow-hidden rounded-lg border border-gray-4">
              <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                <p className="font-medium text-md text-gray-12">
                  DNS Configuration Required
                </p>
                <p className="mt-1 text-sm text-gray-10">
                  To verify your domain ownership, add the following TXT record to your DNS configuration:
                </p>
              </div>
              <div className="px-4 py-3">
                <dl className="grid gap-4">
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Type</dt>
                    <dd className="text-sm text-gray-10">
                      {domainConfig.verification[0].type}
                    </dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Name</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex items-center justify-between gap-1.5 bg-gray-4 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-6">
                        <code className="text-xs truncate">
                          {domainConfig.verification[0].domain}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopy(domainConfig.verification[0].domain, "name")}
                          className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
                          title="Copy to clipboard"
                        >
                          {copiedField === "name" ? (
                            <Check className="size-3.5 text-green-500" />
                          ) : (
                            <Copy className="size-3.5 text-gray-10" />
                          )}
                        </button>
                      </div>
                    </dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Value</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex flex-1 gap-1 justify-between items-center px-2 py-1 min-w-0 rounded-lg border bg-gray-4 border-gray-6">
                        <code className="font-mono text-xs break-all">
                          {domainConfig.verification[0].value}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopy(domainConfig.verification[0].value, "value")}
                          className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
                          title="Copy to clipboard"
                        >
                          {copiedField === "value" ? (
                            <Check className="size-3.5 text-green-500" />
                          ) : (
                            <Copy className="size-3.5 text-gray-10" />
                          )}
                        </button>
                      </div>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          )}

          {/* A Record Configuration */}
          {!domainConfig.verification?.[0] && domainConfig.requiredAValue && (
            <div className="overflow-hidden rounded-lg border border-gray-4">
              <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                <p className="font-medium text-md text-gray-12">
                  DNS Configuration Required
                </p>
                <p className="mt-1 text-sm text-gray-10">
                  To verify your domain ownership, add the following A record to your DNS configuration:
                </p>
              </div>
              <div className="px-4 py-3">
                <dl className="grid gap-4">
                  {domainConfig.currentAValues && domainConfig.currentAValues.length > 0 && (
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-12">Current</dt>
                      <dd className="space-y-1.5 text-sm text-gray-10">
                        {domainConfig.currentAValues.map((value, index) => (
                          <div
                            key={index}
                            className={clsx(
                              value === domainConfig.requiredAValue
                                ? "flex items-center gap-2 text-green-300"
                                : "flex items-center gap-2 text-red-200"
                            )}
                          >
                            <code
                              className={clsx(
                                value === domainConfig.requiredAValue
                                  ? "px-2 py-1 rounded-lg bg-green-900"
                                  : "px-2 py-1 rounded-lg bg-red-900",
                                "text-xs"
                              )}
                            >
                              {value}
                            </code>
                            {value === domainConfig.requiredAValue && (
                              <span className="text-xs text-green-600">(Correct)</span>
                            )}
                          </div>
                        ))}
                      </dd>
                    </div>
                  )}
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Required</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex items-center justify-between gap-1.5 bg-gray-4 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-6">
                        <code className="text-xs text-gray-10">
                          {domainConfig.requiredAValue || "Loading..."}
                        </code>
                        {domainConfig.requiredAValue && (
                          <button
                            type="button"
                            onClick={() =>
                              domainConfig.requiredAValue &&
                              handleCopy(domainConfig.requiredAValue, "value")
                            }
                            className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
                            title="Copy to clipboard"
                          >
                            {copiedField === "value" ? (
                              <Check className="size-3.5 text-green-500" />
                            ) : (
                              <Copy className="size-3.5 text-gray-10" />
                            )}
                          </button>
                        )}
                      </div>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-4 justify-between items-center">
        <Button
          type="button"
          variant="gray"
          size="sm"
          onClick={onPrev}
          className="min-w-[100px]"
        >
          Back
        </Button>

        <div className="flex gap-3">
          <Button
            type="button"
            variant="gray"
            size="sm"
            onClick={handleVerifyClick}
            disabled={verifying}
            className="min-w-[120px]"
          >
            {verifying ? (
              <FontAwesomeIcon className="mr-1 animate-spin size-4" icon={faRefresh} />
            ) : (
              <FontAwesomeIcon className="mr-1 size-4" icon={faRefresh} />
            )}
            Check Status
          </Button>

          {isVerified && (
            <Button
              onClick={onNext}
              size="sm"
              variant="dark"
              className="min-w-[100px]"
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
