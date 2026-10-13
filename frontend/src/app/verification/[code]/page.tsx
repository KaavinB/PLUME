import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui";
import { staticParams } from "@/lib/static-params";
import { Workbench } from "./workbench";

export function generateStaticParams() {
  return staticParams("projects", "code");
}

export default function Page({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Workbench params={params} />
    </Suspense>
  );
}
