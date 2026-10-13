import { expect, test, type Page } from "@playwright/test";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const INCIDENT = "INC-32893D";

async function persona(page: Page, id: string) {
  await page.getByTestId("persona-switcher").click();
  await page.getByTestId(`persona-${id}`).click();
  await expect(page.getByTestId("persona-switcher")).toContainText(id === "sponsor" ? "Sponsor" : id === "provider" ? "Provider" : "Verifier");
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${API}/api/v1/auth/demo-login`, { data: { persona: "admin" } });
  const { token } = await login.json();
  const reset = await request.post(`${API}/api/v1/demo/reset`, { headers: { Authorization: `Bearer ${token}` } });
  expect(reset.ok()).toBeTruthy();
});

test("detection → investigation → funding → repair → verification → proof", async ({ page }) => {
  // 1–3 Mission Control: real observation selected, provenance visible
  await page.goto(`/?incident=${INCIDENT}`);
  await expect(page.getByTestId("incident-drawer")).toBeVisible();
  await expect(page.getByTestId("selected-observation-id")).not.toHaveText("…");
  await expect(page.getByText("Carbon Mapper record").first()).toBeVisible();
  await expect(page.getByTestId("mode-bar")).toContainText("Simulated");

  // 4–5 Investigation (sponsor)
  await persona(page, "sponsor");
  await page.getByTestId("investigate-cta").click();
  await expect(page).toHaveURL(new RegExp(`/incidents/${INCIDENT}`));
  await page.getByTestId("run-investigation").click();
  await expect(page).toHaveURL(/\/investigations\//);
  await expect(page.getByTestId("report-summary")).toContainText(INCIDENT);
  await expect(page.getByText("Grounding check passed")).toBeVisible();
  await expect(page.getByText("Confirmed observations")).toBeVisible();
  await expect(page.getByText("Possible explanations")).toBeVisible();

  // 6–7 Create & fund the repair project
  await page.getByRole("link", { name: "Create repair project" }).click();
  await page.getByTestId("review-terms").click();
  await page.getByTestId("create-draft").click();
  await expect(page).toHaveURL(/\/projects\/RP-/);
  await page.getByTestId("publish-fund").click();
  await expect(page.getByText("Waiting for the provider")).toBeVisible();
  await expect(page.getByText("FUNDED", { exact: true }).last()).toBeVisible();

  // 8 Provider accepts and submits simulated evidence
  await page.getByTestId("switch-provider").click();
  await page.getByTestId("accept").click();
  await expect(page.getByTestId("evidence-form")).toBeVisible();
  const ff = page.getByTestId("advance-time");
  if (await ff.isVisible()) await ff.click();
  await expect(page.getByTestId("submit-evidence")).toBeEnabled();
  await page.getByTestId("submit-evidence").click();
  await expect(page.getByText("Waiting for the verifier")).toBeVisible();

  // 9–10 Verifier reviews and signs
  await page.getByTestId("switch-verifier").click();
  await page.getByRole("link", { name: "Open verification workbench" }).click();
  await expect(page.getByTestId("policy-checks")).toBeVisible();
  await expect(page.locator('[data-check="evidence_hash_consistent"][data-status="pass"]')).toBeVisible();
  await page.getByTestId("outcome-VERIFIED").click();
  await page.getByTestId("decision-notes").fill("Automated journey: documentation complete.");
  await page.getByTestId("sign-decision").click();
  await expect(page.getByTestId("decision-result")).toContainText("VERIFIED");

  // 11 Settlement
  await page.getByRole("link", { name: "Continue to project" }).click();
  await page.getByTestId("release").click();
  await expect(page.getByRole("link", { name: /View proof · RCPT-/ })).toBeVisible();

  // 12 Receipt + independent chain check from the browser
  await page.getByRole("link", { name: /View proof · RCPT-/ }).click();
  await expect(page).toHaveURL(/\/receipts\/RCPT-/);
  await expect(page.getByTestId("proof-chain")).toBeVisible();
  const checks = page.getByTestId("chain-checks");
  await expect(checks).toContainText("Contract state is Paid");
  await expect(checks.locator('[aria-label="Fail"]')).toHaveCount(0);
  await expect(checks.locator('[aria-label="Pass"]')).toHaveCount(5);
});

test("verifier approval is blocked when required evidence is missing", async ({ page, request }) => {
  // Uses the API to reach the review state quickly, then checks the UI gate.
  const tok = async (p: string) => (await (await request.post(`${API}/api/v1/auth/demo-login`, { data: { persona: p } })).json()).token as string;
  const sp = { Authorization: `Bearer ${await tok("sponsor")}` };
  const pv = { Authorization: `Bearer ${await tok("provider")}` };
  const code = "INC-492641";
  await request.post(`${API}/api/v1/incidents/${code}/investigate`, { headers: sp });
  const proj = await (
    await request.post(`${API}/api/v1/repair-projects`, {
      headers: sp,
      data: {
        incident_id: code, title: "Landfill gas collection repair (test)", repair_scope: "Assess and repair gas collection wells near the plume origin.",
        site_authorization: "Operator authorization attested (simulated).", milestones: [{ name: "Repair" }], methodology: "REPAIR_COMPLETION",
        funding_amount_eth: "0.5", provider_id: "provider", verifier_id: "verifier",
      },
    })
  ).json();
  for (const a of ["publish", "fund"]) expect((await request.post(`${API}/api/v1/repair-projects/${proj.code}/${a}`, { headers: sp })).ok()).toBeTruthy();
  expect((await request.post(`${API}/api/v1/repair-projects/${proj.code}/accept`, { headers: pv })).ok()).toBeTruthy();

  await page.goto(`/projects/${proj.code}`);
  await persona(page, "provider");
  await expect(page.getByTestId("evidence-form")).toBeVisible();
  const ff = page.getByTestId("advance-time");
  if (await ff.isVisible()) await ff.click();
  await page.getByTestId("doc-post_repair_survey").uncheck();
  await page.getByTestId("submit-evidence").click();
  await expect(page.getByText("Waiting for the verifier")).toBeVisible();

  await page.getByTestId("switch-verifier").click();
  await page.goto(`/verification/${proj.code}`);
  await expect(page.locator('[data-check="documentation_complete"][data-status="fail"]')).toBeVisible();
  await expect(page.getByTestId("outcome-VERIFIED")).toBeDisabled();
  await page.getByTestId("outcome-REJECTED").click();
  await page.getByTestId("sign-decision").click();
  await expect(page.getByTestId("decision-result")).toContainText("REJECTED");
});
