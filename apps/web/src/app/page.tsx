"use client";

import { Button } from "@launchpad/ui";
import { Campaign } from "@launchpad/core";

export default function Home() {
  const dummyCampaign: Campaign = {
    id: "1",
    name: "Summer Sale",
    status: "active",
    startDate: new Date(),
    endDate: new Date(),
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold mb-4">Welcome to Launchpad!</h1>
      <p className="text-lg mb-8">Your marketing campaign management starts here.</p>
      <Button onClick={() => alert(`Campaign: ${dummyCampaign.name}`)}>
        View Campaigns
      </Button>
    </main>
  );
}
