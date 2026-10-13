import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui";
import { staticParams } from "@/lib/static-params";
import { InvestigationView } from "./investigation-view";

export function generateStaticParams() {
  return staticParams("investigations", "id");
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <InvestigationView params={params} />
    </Suspense>
  );
}
