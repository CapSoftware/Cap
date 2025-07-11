"use client";

import { useState } from "react";
import { lookupUserById } from "./actions";

export default function UserLookup() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    try {
      const formData = new FormData(e.currentTarget);
      const result = await lookupUserById(formData);
      setData(result);
    } catch (error) {
      console.error("Error looking up user:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="userId"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Lookup user by ID
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              name="id"
              id="userId"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              placeholder="Enter user ID"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Loading..." : "Lookup"}
            </button>
          </div>
        </div>
      </form>

      {data && (
        <div className="mt-6 p-4 bg-gray-50 rounded-md">
          <h3 className="text-sm font-medium text-gray-700 mb-2">User Data:</h3>
          <pre className="text-xs text-gray-600 overflow-x-auto">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
