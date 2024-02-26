import React from "react";
import Image from "next/image";
import Page from "../Page";
import { invoke } from "@tauri-apps/api";

export default function Record() {
  const handleRecord = async () => {
    await invoke("capture");
  };

  return (
    <Page>
      <section className="bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0">
          <a
            href="/"
            className="flex items-center gap-2 mb-6 text-2xl font-semibold text-gray-900 dark:text-white"
          >
            <Image src="/images/logo.png" height={32} width={32} alt="logo" />
            Cap App
          </a>

          <div className="flex items-center gap-5">
            <button
              type="button"
              className="text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none dark:focus:ring-blue-800"
              onClick={handleRecord}
            >
              Record
            </button>
          </div>
        </div>
      </section>
    </Page>
  );
}
