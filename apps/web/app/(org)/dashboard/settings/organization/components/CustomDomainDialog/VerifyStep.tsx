import { useState } from "react";
import clsx from "clsx";
import { DomainConfig } from "./types";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

interface VerifyStepProps {
  domain: string;
  domainConfig?: DomainConfig | null;
  isVerified?: boolean;
  verifying?: boolean;
  checkVerification: (showToasts?: boolean) => Promise<void>;
  onNext: () => void;
  onPrev: () => void;
}

export const VerifyStep = ({
  domain,
  domainConfig,
  isVerified,
  checkVerification,
  verifying,
  onNext,
  onPrev
}: VerifyStepProps) => {
  const [copiedField, setCopiedField] = useState<"name" | "value" | null>(null);

  // Get the recommended values from Vercel's response
  const recommendedCnames = domainConfig?.recommendedCNAME || [];
  const recommendedIPv4 = domainConfig?.recommendedIPv4 || [];
  const recommendedARecord = domainConfig?.requiredAValue;
  const currentCnames = domainConfig?.cnames || [];
  const currentAValues = domainConfig?.currentAValues || [];

  // Determine what records to show based on what Vercel actually provides
  const hasVerificationRecord = domainConfig?.verification?.[0];
  const hasRecommendedA = recommendedARecord || recommendedIPv4.length > 0;
  const hasRecommendedCNAME = recommendedCnames.length > 0;

  const showARecord = !hasVerificationRecord && hasRecommendedA;
  const showCNAMERecord = !hasVerificationRecord && hasRecommendedCNAME;

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

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-12">Verify your domain</h3>
        <p className="text-sm text-gray-11">
          Add the DNS records below to verify ownership of {domain}
        </p>
      </div>

      {/* DNS Configuration */}
      {!isVerified && domainConfig && (
        <div className="space-y-4">
          {/* Show both A and CNAME options if available */}

          {/* A Record Configuration */}
          {showARecord && (
            <div className="overflow-hidden rounded-lg border border-gray-4">
              <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                <p className="font-medium text-md text-gray-12">
                  Option 1: A Record {recommendedCnames.length > 0 ? "(Recommended for apex domains)" : ""}
                </p>
                <p className="mt-1 text-sm text-gray-10">
                  Point your domain to Vercel using an A record:
                </p>
              </div>
              <div className="px-4 py-3">
                <dl className="grid gap-4">
                  {/* Current A Values */}
                  {currentAValues.length > 0 && (
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-12">Current</dt>
                      <dd className="space-y-1.5 text-sm text-gray-10">
                        {currentAValues.map((value, index) => (
                          <div
                            key={`a-${index}`}
                            className={clsx(
                              value === recommendedARecord
                                ? "flex items-center gap-2 text-green-300"
                                : "flex items-center gap-2 text-red-200"
                            )}
                          >
                            <code
                              className={clsx(
                                value === recommendedARecord
                                  ? "px-2 py-1 rounded-lg bg-green-900"
                                  : "px-2 py-1 rounded-lg bg-red-900",
                                "text-xs"
                              )}
                            >
                              {value}
                            </code>
                            {value === recommendedARecord && (
                              <span className="text-xs text-green-600">(Correct)</span>
                            )}
                          </div>
                        ))}
                      </dd>
                    </div>
                  )}
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Type</dt>
                    <dd className="text-sm text-gray-10">A</dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Name</dt>
                    <dd className="text-sm text-gray-10">@ (or leave blank)</dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Value</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex items-center justify-between gap-1.5 bg-gray-3 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-4">
                        <code className="text-xs text-gray-10">
                          {recommendedARecord || "Loading..."}
                        </code>
                        {recommendedARecord && (
                          <button
                            type="button"
                            onClick={() => handleCopy(recommendedARecord, "value")}
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

          {/* CNAME Record Configuration */}
          {showCNAMERecord && (
            <div className="overflow-hidden rounded-lg border border-gray-4">
              <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                <p className="font-medium text-md text-gray-12">
                  {showARecord ? "Option 2: CNAME Record" : "CNAME Record"} {showARecord ? "(Alternative)" : ""}
                </p>
                <p className="mt-1 text-sm text-gray-10">
                  {showARecord ? "Alternatively, point your domain using a CNAME record:" : "Point your domain to Vercel using a CNAME record:"}
                </p>
              </div>
              <div className="px-4 py-3">
                <dl className="grid gap-4">
                  {/* Current CNAME Values */}
                  {currentCnames.length > 0 && (
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-12">Current</dt>
                      <dd className="space-y-1.5 text-sm text-gray-10">
                        {currentCnames.map((value, index) => (
                          <div
                            key={`cname-${index}`}
                            className={clsx(
                              recommendedCnames.some(rec => rec.value === value)
                                ? "flex items-center gap-2 text-green-300"
                                : "flex items-center gap-2 text-red-200"
                            )}
                          >
                            <code
                              className={clsx(
                                recommendedCnames.some(rec => rec.value === value)
                                  ? "px-2 py-1 rounded-lg bg-green-900"
                                  : "px-2 py-1 rounded-lg bg-red-900",
                                "text-xs"
                              )}
                            >
                              {value}
                            </code>
                            {recommendedCnames.some(rec => rec.value === value) && (
                              <span className="text-xs text-green-600">(Correct)</span>
                            )}
                          </div>
                        ))}
                      </dd>
                    </div>
                  )}
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Type</dt>
                    <dd className="text-sm text-gray-10">CNAME</dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Name</dt>
                    <dd className="text-sm text-gray-10">
                      <code className="px-2 py-1 text-xs rounded bg-gray-4">
                        {domain.split('.').length > 2 ? domain.split('.')[0] : '@'}
                      </code>
                    </dd>
                  </div>

                  {/* Show ranked CNAME options */}
                  {recommendedCnames
                    .sort((a, b) => a.rank - b.rank)
                    .map((cname, index) => (
                      <div key={cname.rank} className="grid grid-cols-[100px,1fr] items-center">
                        <dt className="text-sm font-medium text-gray-12">
                          {index === 0 ? "Value" : `Option ${index + 1}`}
                        </dt>
                        <dd className="flex gap-2 items-center text-sm text-gray-10">
                          <div className="flex items-center justify-between gap-1.5 bg-gray-3 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-4">
                            <code className="text-xs text-gray-10">
                              {cname.value}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopy(cname.value, "value")}
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
                    ))}
                </dl>
              </div>
            </div>
          )}

          {/* TXT Record Configuration for verification */}
          {hasVerificationRecord && (
            <div className="overflow-hidden rounded-lg border border-gray-4">
              <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                <p className="font-medium text-md text-gray-12">
                  Domain Verification Required
                </p>
                <p className="mt-1 text-sm text-gray-10">
                  First, verify domain ownership with this TXT record:
                </p>
              </div>
              <div className="px-4 py-3">
                <dl className="grid gap-4">
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Type</dt>
                    <dd className="text-sm text-gray-10">
                      {domainConfig?.verification?.[0]?.type || 'TXT'}
                    </dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Name</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex items-center justify-between gap-1.5 bg-gray-3 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-4">
                        <code className="text-xs truncate">
                          {domainConfig?.verification?.[0]?.domain}
                        </code>
                        {domainConfig?.verification?.[0]?.domain && (
                          <button
                            type="button"
                            onClick={() => {
                              const verification = domainConfig?.verification?.[0];
                              if (verification?.domain) {
                                handleCopy(verification.domain, "name");
                              }
                            }}
                            className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
                            title="Copy to clipboard"
                          >
                            {copiedField === "name" ? (
                              <Check className="size-3.5 text-green-500" />
                            ) : (
                              <Copy className="size-3.5 text-gray-10" />
                            )}
                          </button>
                        )}
                      </div>
                    </dd>
                  </div>
                  <div className="grid grid-cols-[100px,1fr] items-center">
                    <dt className="text-sm font-medium text-gray-12">Value</dt>
                    <dd className="flex gap-2 items-center text-sm text-gray-10">
                      <div className="flex items-center justify-between gap-1.5 bg-gray-3 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-4">
                        <code className="font-mono text-xs break-all">
                          {domainConfig?.verification?.[0]?.value || ''}
                        </code>
                        {domainConfig?.verification?.[0]?.value && (
                          <button
                            type="button"
                            onClick={() => {
                              const verification = domainConfig?.verification?.[0];
                              if (verification?.value) {
                                handleCopy(verification.value, "value");
                              }
                            }}
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
    </div>
  );
};
