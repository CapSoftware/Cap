"use client";

export const dynamic = "force-static";

import { CloseX } from "@/components/icons/CloseX";
import { Inter } from "next/font/google";
import SettingsNav from "@/components/settings/Nav";
import { X } from "lucide-react";
import { closeSettingsWindow } from "@/utils/helpers";

const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang='en'>
      <body className={inter.className + "bg-gray-100"}>
        <div className='w-full flex bg-gray-100'>
          <SettingsNav />
          <main className='w-5/6 min-h-screen bg-white relative max-h-screen overflow-scroll p-10'>
            <div className='absolute right-10 top-10'>
              <button className='cursor-pointer' onClick={closeSettingsWindow}>
                <CloseX className='w-5 h-5' />
              </button>
            </div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
