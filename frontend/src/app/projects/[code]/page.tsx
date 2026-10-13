import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui";
import { staticParams } from "@/lib/static-params";
import { ProjectView } from "./project-view";

export function generateStaticParams() {
  return staticParams("projects", "code");
}

export default function Page({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProjectView params={params} />
    </Suspense>
  );
}
