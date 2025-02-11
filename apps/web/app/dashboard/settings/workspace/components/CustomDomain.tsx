export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { useState, useEffect, useRef } from "react";
import { Button, Input, Label } from "@cap/ui";
import { toast } from "react-hot-toast";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { RefreshCw, CheckCircle, XCircle, Copy, Check } from "lucide-react";
import { useRouter } from "next/navigation";

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
  const { activeSpace } = useSharedContext();
  const [domain, setDomain] = useState(activeSpace?.space.customDomain || "");
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState(
    !!activeSpace?.space.domainVerified
  );
  const [domainConfig, setDomainConfig] = useState<DomainConfig | null>(null);
  const [copiedField, setCopiedField] = useState<"name" | "value" | null>(null);
  const initialCheckDone = useRef(false);
  const pollInterval = useRef<NodeJS.Timeout>();
  const POLL_INTERVAL = 5000; // 5 seconds

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

    // Check for valid domain with optional subdomains
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
      const response = await fetch(
        `/api/settings/workspace/domain?spaceId=${activeSpace.space.id}`,
        {
          cache: "no-store",
          next: {
            revalidate: 0,
          },
        }
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to check domain verification");
      }

      setIsVerified(data.verified);
      setDomainConfig(data.config);

      if (showToasts) {
        if (data.verified) {
          toast.success("Domain is verified!");
          // Stop polling once verified
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
    // Start polling if we have a custom domain and it's not verified
    if (activeSpace?.space.customDomain && !isVerified) {
      // Clear any existing interval
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
      }

      // Check immediately
      checkVerification(false);

      // Start polling
      pollInterval.current = setInterval(() => {
        checkVerification(false);
      }, POLL_INTERVAL);
    }

    // Cleanup interval if domain becomes verified or component unmounts
    return () => {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = undefined;
      }
    };
  }, [activeSpace?.space.customDomain, isVerified]);

  // Initial check when component mounts
  useEffect(() => {
    if (!initialCheckDone.current && activeSpace?.space.customDomain) {
      initialCheckDone.current = true;
      checkVerification(false);
    }
  }, [activeSpace?.space.customDomain]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const cleanedDomain = cleanDomain(domain);
    if (!cleanedDomain) {
      toast.error("Please enter a valid domain");
      return;
    }

    setLoading(true);
    setDomain(cleanedDomain); // Update the input to show the cleaned domain

    try {
      const response = await fetch("/api/settings/workspace/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: cleanedDomain,
          spaceId: activeSpace?.space.id,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update domain");
      }

      toast.success("Domain settings updated");
      router.refresh();

      // Set initial domain config from the response
      setDomainConfig(data.status);
      setIsVerified(data.verified);

      // Trigger a refresh after 1 second to get DNS config
      setTimeout(() => {
        checkVerification(false);
      }, 1000);

      // Start polling
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
    if (!confirm("Are you sure you want to remove this custom domain?")) return;

    setLoading(true);
    try {
      const response = await fetch("/api/settings/workspace/domain", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spaceId: activeSpace?.space.id,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to remove domain");
      }

      // Clear polling when domain is removed
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
        <Label htmlFor="customDomain" className="text-sm font-medium">
          Add your custom domain here
        </Label>
        <div className="mt-2 flex gap-2">
          <Input
            type="text"
            id="customDomain"
            placeholder="your-domain.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            disabled={loading}
            className="flex-1"
          />
          <Button type="button" onClick={handleSubmit} disabled={loading}>
            {loading ? "Saving..." : "Save"}
          </Button>
          {activeSpace?.space.customDomain && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => checkVerification(true)}
              disabled={verifying}
              className="w-[105px]"
            >
              {verifying ? (
                <RefreshCw className="mr-2 h-6 w-6 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-6 w-6" />
              )}
              Refresh
            </Button>
          )}
          {activeSpace?.space.customDomain && (
            <Button
              type="button"
              variant="destructive"
              onClick={handleRemoveDomain}
              disabled={loading}
            >
              Remove
            </Button>
          )}
        </div>
        {activeSpace?.space.customDomain && (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-2">
              {isVerified ? (
                <>
                  <div className="flex items-center gap-1.5 text-green-500 bg-green-100 px-2.5 py-1.5 rounded-md text-sm">
                    <CheckCircle className="h-4 w-4" />
                    <span className="font-medium text-green-500 text-sm">
                      Domain verified
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-red-600 bg-red-50 px-2.5 py-1.5 rounded-md text-sm">
                    <XCircle className="h-4 w-4" />
                    <span className="font-medium text-red-500 text-sm">
                      Domain not verified
                    </span>
                  </div>
                </>
              )}
            </div>
            {!isVerified && domainConfig?.verification?.[0] && (
              <div className="rounded-lg border border-gray-200 overflow-hidden">
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
                      <dd className="flex items-center gap-2 text-sm text-gray-900">
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
                              className="p-1 hover:bg-gray-100 rounded-md transition-colors shrink-0"
                              title="Copy to clipboard"
                            >
                              {copiedField === "name" ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4 text-gray-500" />
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
                      <dd className="flex items-center gap-2 text-sm text-gray-900">
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
                              className="p-1 hover:bg-gray-100 rounded-md transition-colors shrink-0"
                              title="Copy to clipboard"
                            >
                              {copiedField === "value" ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4 text-gray-500" />
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
                <div className="rounded-lg border border-gray-200 overflow-hidden mt-4">
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
                                    className="flex items-center gap-2"
                                  >
                                    <code className="bg-gray-50 px-2 py-1 rounded">
                                      {value}
                                    </code>
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
                        <dd className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5 bg-gray-50 px-2 py-1 rounded flex-1 min-w-0">
                            <code className="text-sm text-green-600">
                              {domainConfig.requiredAValue}
                            </code>
                            <button
                              type="button"
                              onClick={() =>
                                domainConfig.requiredAValue &&
                                handleCopy(domainConfig.requiredAValue, "value")
                              }
                              className="p-1 hover:bg-gray-100 rounded-md transition-colors shrink-0"
                              title="Copy to clipboard"
                            >
                              {copiedField === "value" ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4 text-gray-500" />
                              )}
                            </button>
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
    </div>
  );
}
