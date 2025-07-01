export const revalidate = 0;
export const fetchCache = "force-no-store";

import { checkOrganizationDomain } from "@/actions/organization/check-domain";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";
import { updateDomain } from "@/actions/organization/update-domain";
import { UpgradeModal } from "@/components/UpgradeModal";
import { Button, Input } from "@cap/ui";
import { faRefresh, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { Check, CheckCircle, Copy, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";

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

interface CustomDomainProps {
  isOwner: boolean;
  showOwnerToast: () => void;
}

export function CustomDomain({ isOwner, showOwnerToast }: CustomDomainProps) {
  const router = useRouter();
  const { activeOrganization, isSubscribed } = useDashboardContext();
  const [domain, setDomain] = useState(
    activeOrganization?.organization.customDomain || ""
  );
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState(
    !!activeOrganization?.organization.domainVerified
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
    if (
      !activeOrganization?.organization.id ||
      !activeOrganization?.organization.customDomain
    )
      return;
    setVerifying(true);
    try {
      const data = await checkOrganizationDomain(
        activeOrganization.organization.id
      );

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
    if (activeOrganization?.organization.customDomain && !isVerified) {
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
  }, [activeOrganization?.organization.customDomain, isVerified]);

  useEffect(() => {
    if (
      !initialCheckDone.current &&
      activeOrganization?.organization.customDomain
    ) {
      initialCheckDone.current = true;
      checkVerification(false);
    }
  }, [activeOrganization?.organization.customDomain]);

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
        activeOrganization?.organization.id as string
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
      await removeOrganizationDomain(
        activeOrganization?.organization.id as string
      );

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
    <div className="flex flex-wrap mt-4 space-y-6">
      <div className="flex-1">
        <div className="flex flex-col justify-between items-start">
          <Input
            type="text"
            id="customDomain"
            placeholder={isOwner ? "your-domain.com" : "Only the owner of the organization can change this"}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            disabled={!isOwner}
            className="flex-1 min-h-[44px]"
          />
          <div className="flex gap-2 justify-between items-center mt-4">
            {activeOrganization?.organization.customDomain &&
              (isVerified ? (
                <>
                  <div className="flex items-center gap-1 text-white bg-green-600 px-2.5 py-1.5 rounded-full text-sm">
                    <CheckCircle className="size-3" />
                    <span className="text-xs font-medium text-white">
                      Domain verified
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1 text-white bg-red-500 px-2.5 py-1.5 rounded-full text-sm">
                    <XCircle className="size-3" />
                    <span className="text-xs font-medium text-white">
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
              spinner={loading}
              disabled={loading}
            >
              {loading ? "Saving..." : "Save"}
            </Button>
            <div className="flex gap-3 items-center">
              {activeOrganization?.organization.customDomain && (
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
                      className="animate-spin size-3 mr-0.5"
                      icon={faRefresh}
                    />
                  ) : (
                    <FontAwesomeIcon className="size-3 mr-0.5" icon={faRefresh} />
                  )}
                  Refresh
                </Button>
              )}
              {activeOrganization?.organization.customDomain && (
                <Button
                  type="button"
                  size="sm"
                  variant="white"
                  onClick={handleRemoveDomain}
                  disabled={loading}
                >
                  <FontAwesomeIcon className="size-3 mr-0.5" icon={faTrash} />
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
        {activeOrganization?.organization.customDomain && (
          <div className="mt-4 space-y-4">
            {!isVerified && domainConfig?.verification?.[0] && (
              <div className="overflow-hidden rounded-lg border border-gray-4">
                <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                  <p className="font-medium text-md text-gray-12">
                    DNS Configuration Required
                  </p>
                  <p className="mt-1 text-sm text-gray-10">
                    To verify your domain ownership, add the following TXT
                    record to your DNS configuration:
                  </p>
                </div>
                <div className="px-4 py-3">
                  <dl className="grid gap-4">
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-12">Type</dt>
                      <dd className="text-sm text-gray-10">
                        {domainConfig?.verification?.[0]?.type}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[100px,1fr] items-center">
                      <dt className="text-sm font-medium text-gray-12">Name</dt>
                      <dd className="flex gap-2 items-center text-sm text-gray-10">
                        <div className="flex items-center justify-between gap-1.5
                       bg-gray-4 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-6">
                          <code className="text-xs truncate">
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
                        <div className="flex flex-1 gap-1 justify-between items-center px-2 py-1 min-w-0 rounded-lg border bg-gray-4 border-gray-6">
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



            {!isVerified &&
              !domainConfig?.verification?.[0] &&
              domainConfig?.requiredAValue && (
                <div className="overflow-hidden rounded-lg border border-gray-4">
                  <div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
                    <p className="font-medium text-md text-gray-12">
                      DNS Configuration Required
                    </p>
                    <p className="mt-1 text-sm text-gray-10">
                      To verify your domain ownership, add the following A
                      record to your DNS configuration:
                    </p>
                  </div>
                  <div className="px-4 py-3">
                    <dl className="grid gap-4">
                      {domainConfig.currentAValues &&
                        domainConfig.currentAValues.length > 0 && (
                          <div className="grid grid-cols-[100px,1fr] items-center">
                            <dt className="text-sm font-medium text-gray-12">
                              Current
                            </dt>
                            <dd className="space-y-1.5 text-sm text-gray-10">
                              {domainConfig.currentAValues.map(
                                (value, index) => (
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
                                      )
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
                        <dt className="text-sm font-medium text-gray-12">
                          Required
                        </dt>
                        <dd className="flex gap-2 items-center text-sm text-gray-10">
                          <div className="flex items-center justify-between gap-1.5
                       bg-gray-4 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-6">
                            <code className="text-xs text-gray-10">
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
      {showUpgradeModal && (
        <UpgradeModal
          open={showUpgradeModal}
          onOpenChange={setShowUpgradeModal}
        />
      )}
    </div>
  );
}
