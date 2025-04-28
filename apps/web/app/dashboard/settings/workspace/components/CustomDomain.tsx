export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { checkWorkspaceDomain } from "@/actions/workspace/check-domain";
import { removeWorkspaceDomain } from "@/actions/workspace/remove-domain";
import { updateDomain } from "@/actions/workspace/update-domain";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Button, Input } from "@cap/ui";
import { faRefresh, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Check, CheckCircle, Copy, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { UpgradeModal } from "@/components/UpgradeModal";

type DomainVerification = {
  type: string;
  domain: string;
  value: string;
  reason: string;
};

type DomainConfig = {
  name: string;
  apexName: string;
  verification: DomainVerification[];
  verified: boolean;
  misconfigured?: boolean;
  aValues?: string[];
  currentAValues?: string[];
  requiredAValue?: string;
};

type VerificationResponse = {
  verified: boolean;
  config: DomainConfig;
  status: any;
  aRecordConfig?: {
    current: string;
    required: string;
  };
};

export function CustomDomain() {
  const router = useRouter();
  const { activeSpace, isSubscribed } = useSharedContext();
  const [domain, setDomain] = useState(activeSpace?.space.customDomain || "");
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState(
    !!activeSpace?.space.domainVerified
  );
  const [domainConfig, setDomainConfig] = useState<DomainConfig | null>(null);
  const [copiedField, setCopiedField] = useState<"name" | "value" | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const initialCheckDone = useRef(false);
  const pollInterval = useRef<NodeJS.Timeout>();
  const POLL_INTERVAL = 5000;

  const cleanDomain = (input: string) => {
    if (!input) return "";

    if (input === "cap.so" || input === "cap.link") {
      return "";
    }

    const withoutProtocol = input.replace(/^(https?:\/\/)?(www\.)?/i, "");
    const parts = withoutProtocol.split("/");
    const domain = parts[0] || "";
    const withoutQuery = domain.split("?")[0] || "";
    const withoutHash = withoutQuery.split("#")[0] || "";
    const cleanedDomain = withoutHash.trim();

    const hasTLD =
      /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(
        cleanedDomain
      );

    return hasTLD ? cleanedDomain : "";
  };

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

  const checkVerification = async (showToasts = true) => {
    if (!activeSpace?.space.id || !activeSpace?.space.customDomain) return;
    setVerifying(true);
    try {
      const data = await checkWorkspaceDomain(activeSpace.space.id);

      setIsVerified(data.verified);
      setDomainConfig(data.config);

      if (showToasts) {
        if (data.verified) {
          toast.success("Domain is verified!");

          if (pollInterval.current) {
            clearInterval(pollInterval.current);
            pollInterval.current = undefined;
          }
        } else {
          toast.error(
            "Domain is not verified. Please check your DNS settings."
          );
        }
      }
    } catch (error) {
      if (showToasts) {
        toast.error("Failed to check domain verification");
      }
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    if (activeSpace?.space.customDomain && !isVerified) {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
      }

      checkVerification(false);

      pollInterval.current = setInterval(() => {
        checkVerification(false);
      }, POLL_INTERVAL);
    }

    return () => {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = undefined;
      }
    };
  }, [activeSpace?.space.customDomain, isVerified]);

  useEffect(() => {
    if (!initialCheckDone.current && activeSpace?.space.customDomain) {
      initialCheckDone.current = true;
      checkVerification(false);
    }
  }, [activeSpace?.space.customDomain]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isSubscribed) {
      setShowUpgradeModal(true);
      return;
    }

    const cleanedDomain = cleanDomain(domain);
    if (!cleanedDomain) {
      toast.error("Please enter a valid domain");
      return;
    }

    setLoading(true);
    setDomain(cleanedDomain);

    try {
      const data = await updateDomain(
        cleanedDomain,
        activeSpace?.space.id as string
      );

      toast.success("Domain settings updated");
      router.refresh();

      setDomainConfig(data.status);
      setIsVerified(data.verified);

      setTimeout(() => {
        checkVerification(false);
      }, 1000);

      pollInterval.current = setInterval(() => {
        checkVerification(false);
      }, POLL_INTERVAL);
    } catch (error) {
      toast.error("Failed to update domain settings");
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveDomain = async () => {
    if (!isSubscribed) {
      setShowUpgradeModal(true);
      return;
    }

    if (!confirm("Are you sure you want to remove this custom domain?")) return;

    setLoading(true);
    try {
      await removeWorkspaceDomain(activeSpace?.space.id as string);

      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = undefined;
      }

      setDomain("");
      setIsVerified(false);
      toast.success("Custom domain removed");
      router.refresh();
    } catch (error) {
      toast.error("Failed to remove domain");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-col justify-between items-start mt-2 h-full">
          <Input
            type="text"
            id="customDomain"
            placeholder="your-domain.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            disabled={loading}
            className="flex-1"
          />
          <div className="flex gap-2 justify-between items-center mt-4">
            {activeSpace?.space.customDomain &&
              (isVerified ? (
                <>
                  <div className="flex items-center gap-1.5 text-green-500 bg-green-200 px-2.5 py-1.5 rounded-xl text-sm">
                    <CheckCircle className="size-3" />
                    <span className="text-xs font-medium text-green-500">
                      Domain verified
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-red-600 bg-red-50 px-2.5 py-1.5 rounded-md text-sm">
                    <XCircle className="w-4 h-4" />
                    <span className="text-sm font-medium text-red-500">
                      Domain not verified
                    </span>
                  </div>
                </>
              ))}
          </div>
          <div className="flex gap-3 justify-between items-center mt-8 w-full">
            <Button
              type="submit"
              size="sm"
              variant="dark"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? "Saving..." : "Save"}
            </Button>
            <div className="flex gap-3 items-center">
              {activeSpace?.space.customDomain && (
                <Button
                  type="button"
                  variant="white"
                  size="sm"
                  onClick={() => checkVerification(true)}
                  disabled={verifying}
                  className="w-[105px]"
                >
                  {verifying ? (
                    <FontAwesomeIcon
                      className="animate-spin size-6"
                      icon={faRefresh}
                    />
                  ) : (
                    <FontAwesomeIcon className="mr-1 size-4" icon={faRefresh} />
                  )}
                  Refresh
                </Button>
              )}
              {activeSpace?.space.customDomain && (
                <Button
                  type="button"
                  size="sm"
                  variant="white"
                  onClick={handleRemoveDomain}
                  disabled={loading}
                >
                  <FontAwesomeIcon className="mr-1 size-4" icon={faTrash} />
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
        {activeSpace?.space.customDomain && (
          <div className="mt-4 space-y-4">
            {!isVerified && domainConfig?.verification?.[0] && (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h4 className="font-medium text-gray-900">
                    DNS Configuration Required
                  </h4>
                  <p className="mt-1 text-sm text-gray-600">
                    To verify your domain ownership, add the following TXT
                    record to your DNS configuration:
                  </p>
                </div>
                <div className="px-4 py-3">
                  <dl className="grid gap-4">
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-500">
                        Type
                      </dt>
                      <dd className="text-sm text-gray-900">
                        {domainConfig?.verification?.[0]?.type}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-500">
                        Name
                      </dt>
                      <dd className="flex gap-2 items-center text-sm text-gray-900">
                        <div className="flex items-center gap-1.5 bg-gray-50 px-2 py-1 rounded flex-1 min-w-0">
                          <code className="truncate">
                            {domainConfig?.verification?.[0]?.domain}
                          </code>
                          {domainConfig?.verification?.[0]?.domain && (
                            <button
                              type="button"
                              onClick={() => {
                                const domain =
                                  domainConfig?.verification?.[0]?.domain;
                                if (domain) handleCopy(domain, "name");
                              }}
                              className="p-1 rounded-md transition-colors hover:bg-gray-100 shrink-0"
                              title="Copy to clipboard"
                            >
                              {copiedField === "name" ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4 text-gray-500" />
                              )}
                            </button>
                          )}
                        </div>
                      </dd>
                    </div>
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-500">
                        Value
                      </dt>
                      <dd className="flex gap-2 items-center text-sm text-gray-900">
                        <div className="flex items-center gap-1.5 bg-gray-50 p-2 rounded flex-1 min-w-0">
                          <code className="font-mono text-xs break-all">
                            {domainConfig?.verification?.[0]?.value}
                          </code>
                          {domainConfig?.verification?.[0]?.value && (
                            <button
                              type="button"
                              onClick={() => {
                                const value =
                                  domainConfig?.verification?.[0]?.value;
                                if (value) handleCopy(value, "value");
                              }}
                              className="p-1 rounded-md transition-colors hover:bg-gray-100 shrink-0"
                              title="Copy to clipboard"
                            >
                              {copiedField === "value" ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4 text-gray-500" />
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

            {!isVerified &&
              !domainConfig?.verification?.[0] &&
              domainConfig?.requiredAValue && (
                <div className="overflow-hidden mt-4 rounded-lg border border-gray-200">
                  <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                    <h4 className="font-medium text-gray-900">
                      DNS Configuration Required
                    </h4>
                    <p className="mt-1 text-sm text-gray-600">
                      Please configure your DNS settings with the following A
                      record:
                    </p>
                  </div>
                  <div className="px-4 py-3">
                    <dl className="grid gap-4">
                      {domainConfig.currentAValues &&
                        domainConfig.currentAValues.length > 0 && (
                          <div className="grid grid-cols-[100px,1fr] items-center">
                            <dt className="text-sm font-medium text-gray-500">
                              Current
                            </dt>
                            <dd className="text-sm text-gray-600">
                              {domainConfig.currentAValues.map(
                                (value, index) => (
                                  <div
                                    key={index}
                                    className={
                                      value === domainConfig.requiredAValue
                                        ? "flex items-center gap-2 text-green-600"
                                        : "flex items-center gap-2 text-red-600"
                                    }
                                  >
                                    <code
                                      className={
                                        value === domainConfig.requiredAValue
                                          ? "px-2 py-1 rounded bg-green-50"
                                          : "px-2 py-1 rounded bg-red-50"
                                      }
                                    >
                                      {value}
                                    </code>
                                    {value === domainConfig.requiredAValue && (
                                      <span className="text-xs text-green-600">
                                        (Correct)
                                      </span>
                                    )}
                                  </div>
                                )
                              )}
                            </dd>
                          </div>
                        )}
                      <div className="grid grid-cols-[100px,1fr] items-center">
                        <dt className="text-sm font-medium text-gray-500">
                          Required
                        </dt>
                        <dd className="flex gap-2 items-center">
                          <div className="flex items-center gap-1.5 bg-gray-50 px-2 py-1 rounded flex-1 min-w-0">
                            <code className="text-sm text-gray-900">
                              {domainConfig.requiredAValue || "Loading..."}
                            </code>
                            {domainConfig.requiredAValue && (
                              <button
                                type="button"
                                onClick={() =>
                                  domainConfig.requiredAValue &&
                                  handleCopy(
                                    domainConfig.requiredAValue,
                                    "value"
                                  )
                                }
                                className="p-1 rounded-md transition-colors hover:bg-gray-100 shrink-0"
                                title="Copy to clipboard"
                              >
                                {copiedField === "value" ? (
                                  <Check className="w-4 h-4 text-green-500" />
                                ) : (
                                  <Copy className="w-4 h-4 text-gray-500" />
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
      {showUpgradeModal && (
        <UpgradeModal
          open={showUpgradeModal}
          onOpenChange={setShowUpgradeModal}
        />
      )}
    </div>
  );
}
