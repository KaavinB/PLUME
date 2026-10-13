import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui";
import { staticParams } from "@/lib/static-params";
import { ReceiptView } from "./receipt-view";

export function generateStaticParams() {
  return staticParams("receipts", "id");
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReceiptView params={params} />
    </Suspense>
  );
}
