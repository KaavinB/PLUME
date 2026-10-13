import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui";
import { staticParams } from "@/lib/static-params";
import { IncidentView } from "./incident-view";

export function generateStaticParams() {
  return staticParams("incidents", "code");
}

export default function Page({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IncidentView params={params} />
    </Suspense>
  );
}
