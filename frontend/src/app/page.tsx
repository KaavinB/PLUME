import { Suspense } from "react";

import { MissionControl } from "./mission-control";

export default function Page() {
  return (
    <Suspense fallback={<div className="absolute inset-0 bg-bg" aria-busy="true" />}>
      <MissionControl />
    </Suspense>
  );
}
