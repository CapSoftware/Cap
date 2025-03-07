"use client";

import { useState } from "react";
import { lookupUserById } from "./actions";
import Link from "next/link";
import { Button } from "@cap/ui";

export default function AdminPage() {
  const [data, setData] = useState<any>(null);

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Admin Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <h2 className="text-xl font-semibold mb-4">Server Configuration</h2>
          <p className="text-gray-600 mb-4">
            Manage server settings including license key, signup settings, and
            email configuration.
          </p>
          <Link href="/dashboard/admin/server-config">
            <Button variant="primary">Manage Configuration</Button>
          </Link>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <h2 className="text-xl font-semibold mb-4">User Lookup</h2>
          <p className="text-gray-600 mb-4">Look up user information by ID.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              lookupUserById(new FormData(e.currentTarget)).then(setData);
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium mb-1">User ID</label>
              <input
                type="text"
                name="id"
                className="w-full p-2 border border-gray-300 rounded"
                placeholder="Enter user ID"
              />
            </div>
            <Button type="submit" variant="primary">
              Lookup
            </Button>
          </form>
        </div>
      </div>

      {data && (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <h2 className="text-xl font-semibold mb-4">User Information</h2>
          <pre className="bg-gray-100 p-4 rounded overflow-auto max-h-96">
            {JSON.stringify(data, null, 4)}
          </pre>
        </div>
      )}
    </div>
  );
}
