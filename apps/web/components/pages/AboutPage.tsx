"use client";

import { Button } from "@cap/ui";

export const AboutPage = () => {
  return (
    <div className="wrapper wrapper-sm pt-32 pb-20">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-semibold mb-4 fade-in-down animate-delay-1">
          About Cap
        </h1>
        <p className="text-lg text-gray-400 max-w-2xl mx-auto fade-in-down animate-delay-2 leading-relaxed">
          Screen recording made simple, secure, and powerful.
        </p>
      </div>

      <div className="bg-gray-50/3 rounded-lg p-5 mb-8 fade-in-up animate-delay-2">
        <p className="text-lg">
          Your recordings shouldn't be locked away in systems you don't control.
          At Cap, we're building a screen recording tool that puts you first,
          respects your privacy, and gives you full control over your content.
        </p>
      </div>

      <div className="fade-in-up animate-delay-2 space-y-8">
        <div>
          <h2 className="text-2xl font-medium mb-3">Why Cap?</h2>
          <p className="text-lg">
            Cap started with a simple idea: great ideas should be easy to share.
            Whether you're explaining a concept, showing how something works, or
            working with others, the tools you use should make your job easier,
            not harder.
          </p>
        </div>

        <div className="space-y-8">
          <div>
            <h2 className="text-2xl font-medium mb-3">The Problem</h2>
            <p className="text-lg">
              After years of using other screen recording tools, we found they
              often don't respect your privacy, limit what you can do, and lock
              your content in their systems. Most of these tools are run by big
              companies that are slow to improve and don't listen to what users
              actually need.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-medium mb-3">Our Solution</h2>
            <p className="text-lg">
              So we built Cap—a simple, complete screen recording tool that
              anyone can use. Inspired by tools we love and built on principles
              we believe in, our goal is to help you share ideas easily while
              keeping control of your content. Cap makes your recordings better
              with features like automatic captions, easy zooming, simple
              editing, and flexible sharing options.
            </p>
          </div>
        </div>

        <div>
          <h2 className="text-2xl font-medium mb-3">Two Ways to Record</h2>
          <p className="text-lg mb-4">
            Cap gives you two simple ways to record:
          </p>
          <div className="space-y-4 ml-4">
            <div>
              <h3 className="text-xl font-medium">Instant Mode</h3>
              <p className="text-lg">
                Share your screen right away with a simple link—no waiting, just
                record and share in seconds.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-medium">Studio Mode</h3>
              <p className="text-lg">
                Records at top quality. Captures both your screen and webcam
                separately so you can edit them later.
              </p>
            </div>
          </div>
        </div>

        <div>
          <h2 className="text-2xl font-medium mb-3">Privacy First</h2>
          <p className="text-lg">
            Unlike other tools, Cap is built with your privacy as a top
            priority. We don't trap your data or force you to use only our
            systems. You can connect your own storage, keeping complete control
            of your recordings forever.
          </p>
        </div>

        <div>
          <h2 className="text-2xl font-medium mb-3">Open to Everyone</h2>
          <p className="text-lg">
            We believe in being open and transparent. Cap's code is available
            for anyone to see, use, and improve. This means your data will
            always be accessible, and our tool will keep getting better through
            community feedback and contributions.
          </p>
        </div>

        <div>
          <h2 className="text-2xl font-medium mb-3">Join Us</h2>
          <p className="text-lg">
            We're working to make Cap the best screen recording tool for
            everyone. Whether you're creating content alone, working with a
            startup, or part of a large team, Cap works for you.
          </p>
          <p className="text-lg mt-3">
            Together, we're making it easier for everyone to share ideas and
            connect—one recording at a time.
          </p>
          <div className="mt-6">
            <Button
              className="inline-flex"
              href="/download"
              variant="primary"
              size="lg"
            >
              Download Cap
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
