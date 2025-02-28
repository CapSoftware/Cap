"use client";

import { useState, useEffect } from "react";
import {
  getServerConfiguration,
  updateServerConfiguration,
  searchUsersByEmail,
  addSuperAdmin,
  removeSuperAdmin,
  getSuperAdminUsers,
  getCurrentUserId,
} from "../actions";
import { Button } from "@cap/ui";
import { Input } from "@cap/ui";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ServerConfigFormValues,
  SuperAdminUser,
  serverConfigSchema,
} from "./schema";

export default function ServerConfigPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // React Hook Form setup
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ServerConfigFormValues>({
    resolver: zodResolver(serverConfigSchema),
    defaultValues: {
      licenseKey: null,
      signupsEnabled: false,
      emailSendFromName: null,
      emailSendFromEmail: null,
    },
  });

  // Super admin management
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SuperAdminUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [superAdmins, setSuperAdmins] = useState<SuperAdminUser[]>([]);
  const [superAdminError, setSuperAdminError] = useState<string | null>(null);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Perform search when debounced query changes
  useEffect(() => {
    if (debouncedSearchQuery.trim().length >= 3) {
      performSearch(debouncedSearchQuery);
    } else {
      setSearchResults([]);
    }
  }, [debouncedSearchQuery]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const config = await getServerConfiguration();
        if (config) {
          setData(config);
          setError(null);

          // Set form default values
          reset({
            licenseKey: config.licenseKey || null,
            signupsEnabled: config.signupsEnabled || false,
            emailSendFromName: config.emailSendFromName || null,
            emailSendFromEmail: config.emailSendFromEmail || null,
          });
        }

        // Fetch super admin users
        const adminUsers = await getSuperAdminUsers();
        setSuperAdmins(adminUsers);

        // Get current user ID
        const userId = await getCurrentUserId();
        setCurrentUserId(userId);
      } catch (err) {
        setError("Failed to load server configuration");
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [reset]);

  const onSubmit = async (values: ServerConfigFormValues) => {
    setError(null);
    setSuccess(false);

    try {
      const updatedConfig = await updateServerConfiguration(values);
      setData(updatedConfig);
      setSuccess(true);

      // Reset success message after 3 seconds
      setTimeout(() => {
        setSuccess(false);
      }, 3000);
    } catch (err) {
      setError("Failed to update server configuration");
      console.error(err);
    }
  };

  // Perform search with debounce
  const performSearch = async (query: string) => {
    if (query.trim().length < 3) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    setSuperAdminError(null);

    try {
      const results = await searchUsersByEmail(query);
      setSearchResults(results);
    } catch (err) {
      setSuperAdminError("Failed to search for users");
      console.error(err);
    } finally {
      setSearching(false);
    }
  };

  // Handle user search button click
  const handleSearchButtonClick = () => {
    performSearch(searchQuery);
  };

  // Add user as super admin
  const handleAddSuperAdmin = async (userId: string) => {
    setSuperAdminError(null);

    try {
      const updatedConfig = await addSuperAdmin(userId);
      setData(updatedConfig);

      // Refresh super admin list
      const adminUsers = await getSuperAdminUsers();
      setSuperAdmins(adminUsers);

      // Clear search
      setSearchQuery("");
      setSearchResults([]);
    } catch (err) {
      setSuperAdminError("Failed to add super admin");
      console.error(err);
    }
  };

  // Remove user from super admin list
  const handleRemoveSuperAdmin = async (userId: string) => {
    setSuperAdminError(null);

    try {
      const updatedConfig = await removeSuperAdmin(userId);
      setData(updatedConfig);

      // Refresh super admin list
      const adminUsers = await getSuperAdminUsers();
      setSuperAdmins(adminUsers);
    } catch (err) {
      setSuperAdminError(
        err instanceof Error ? err.message : "Failed to remove super admin"
      );
      console.error(err);
    }
  };

  // Check if user is the current user
  const isCurrentUser = (userId: string) => {
    return userId === currentUserId;
  };

  if (loading && !data) {
    return <div className="p-4">Loading...</div>;
  }

  if (error && !data) {
    return <div className="p-4 text-red-500">{error}</div>;
  }

  return (
    <div className="p-4 max-w-2xl mx-auto flex flex-col gap-6">
      <h1 className="text-3xl font-bold mb-6">Server Configuration</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-100 text-red-700 rounded">{error}</div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-100 text-green-700 rounded">
          Configuration updated successfully!
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium mb-1 text-gray-500">
              License Key
            </label>
            <Input
              type="text"
              {...register("licenseKey")}
              className="w-full max-w-full"
            />
            {errors.licenseKey && (
              <p className="text-sm text-red-500 mt-1">
                {errors.licenseKey.message}
              </p>
            )}
            <div className="flex flex-row items-center justify-between gap-4">
              <p className="text-sm text-gray-500 mt-1">Your Cap license key</p>
              {data?.licenseValid !== undefined && (
                <div
                  className={`text-sm ${
                    data.licenseValid ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {data.licenseValid ? "Valid" : "Invalid"}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 text-gray-500">
              Signups Enabled
            </label>
            <div className="flex items-center">
              <input
                type="checkbox"
                {...register("signupsEnabled")}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <span className="ml-2 text-sm">Allow new user signups</span>
            </div>
            {errors.signupsEnabled && (
              <p className="text-sm text-red-500 mt-1">
                {errors.signupsEnabled.message}
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium mb-1 text-gray-500">
              Email From Name
            </label>
            <Input
              type="text"
              {...register("emailSendFromName")}
              className="w-full max-w-full"
            />
            {errors.emailSendFromName && (
              <p className="text-sm text-red-500 mt-1">
                {errors.emailSendFromName.message}
              </p>
            )}
            <p className="text-sm text-gray-500 mt-1">
              Name to use in the "From" field for emails
            </p>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 text-gray-500">
              Email From Address
            </label>
            <Input
              type="email"
              {...register("emailSendFromEmail")}
              className="w-full max-w-full"
            />
            {errors.emailSendFromEmail && (
              <p className="text-sm text-red-500 mt-1">
                {errors.emailSendFromEmail.message}
              </p>
            )}
            <p className="text-sm text-gray-500 mt-1">
              Email address to use in the "From" field
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save Server Configuration"}
          </Button>
        </div>
      </form>

      {/* Super Admin Management */}
      <div className="mt-8 border-t pt-6">
        <h2 className="text-2xl font-semibold mb-4">Super Admin Management</h2>
        <p className="text-sm text-gray-500 mb-4">
          Manage who can access this page and change server configuration
        </p>

        {superAdminError && (
          <div className="mb-4 p-3 bg-red-100 text-red-700 rounded">
            {superAdminError}
          </div>
        )}

        <div className="mb-6">
          <label className="text-sm font-medium mb-1 text-gray-500">
            Search Users by Email
          </label>
          <div className="flex space-x-2">
            <Input
              type="email"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Enter email address (min 3 characters)"
              className="w-full max-w-full"
            />
            <Button
              type="button"
              onClick={handleSearchButtonClick}
              disabled={searching || searchQuery.trim().length < 3}
            >
              {searching ? "Searching..." : "Search"}
            </Button>
          </div>

          {searching && (
            <div className="mt-2 text-sm text-gray-500">Searching...</div>
          )}

          {/* Search Results */}
          {searchResults.length > 0 && !searching && (
            <div className="mt-2 border rounded-md overflow-hidden">
              {searchResults.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between p-3 border-b last:border-b-0 hover:bg-gray-50"
                >
                  <div className="flex items-center">
                    {user.image && (
                      <img
                        src={user.image}
                        alt={user.name || user.email}
                        className="w-8 h-8 rounded-full mr-3"
                      />
                    )}
                    <div>
                      {user.name && (
                        <div className="font-medium">{user.name}</div>
                      )}
                      <div className="text-sm text-gray-500">{user.email}</div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleAddSuperAdmin(user.id)}
                    disabled={data?.superAdminIds?.includes(user.id)}
                  >
                    {data?.superAdminIds?.includes(user.id)
                      ? "Already Admin"
                      : "Add as Admin"}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {searchQuery.trim().length >= 3 &&
            searchResults.length === 0 &&
            !searching && (
              <div className="mt-2 text-sm text-gray-500">
                No users found matching "{searchQuery}"
              </div>
            )}
        </div>

        {/* Current Super Admins */}
        <div>
          <h3 className="font-medium mb-2">Current Super Admins</h3>

          {superAdmins.length === 0 ? (
            <div className="text-sm text-gray-500">
              No super admins configured
            </div>
          ) : (
            <div className="border rounded-md overflow-hidden">
              {superAdmins.map((admin) => (
                <div
                  key={admin.id}
                  className="flex items-center justify-between p-3 border-b last:border-b-0 hover:bg-gray-50"
                >
                  <div className="flex items-center">
                    {admin.image && (
                      <img
                        src={admin.image}
                        alt={admin.name || admin.email}
                        className="w-8 h-8 rounded-full mr-3"
                      />
                    )}
                    <div>
                      {admin.name && (
                        <div className="font-medium">
                          {admin.name}
                          {isCurrentUser(admin.id) && (
                            <span className="ml-2 text-xs text-blue-500 font-normal">
                              (You)
                            </span>
                          )}
                        </div>
                      )}
                      <div className="text-sm text-gray-500">{admin.email}</div>
                    </div>
                  </div>
                  <div className="relative group">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => handleRemoveSuperAdmin(admin.id)}
                      disabled={isCurrentUser(admin.id)}
                    >
                      Remove
                    </Button>
                    {isCurrentUser(admin.id) && (
                      <div className="absolute right-0 bottom-full mb-2 w-48 p-2 bg-gray-800 text-white text-xs rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                        You cannot remove yourself from super admins
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Current Configuration */}
      <div className="mt-8 border-t pt-6">
        <h2 className="text-xl font-semibold mb-4">Current Configuration</h2>
        <pre className="bg-gray-100 p-4 rounded overflow-auto max-h-96">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
