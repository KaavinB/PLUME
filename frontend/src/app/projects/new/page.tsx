import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui";
import { NewProject } from "./new-project";

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewProject />
    </Suspense>
  );
}
