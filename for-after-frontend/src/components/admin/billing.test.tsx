import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BillingSummary } from "@/lib/api/admin";
import { json, renderWithClient, routeFetch, router } from "@/test/utils";
import { AdminBillingList } from "./billing";

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/billing",
}));

const ID = "11111111-1111-4111-8111-111111111111";
const T = "2026-11-12T02:00:00.000Z";
const row = (over: Partial<BillingSummary> = {}): BillingSummary => ({
  accountId: ID,
  email: "ana.test@example.test",
  firstName: "Ana",
  lastName: "Test",
  accountCreatedAt: T,
  state: "cancellation_scheduled",
  hasAccess: true,
  trialStartedAt: null,
  trialEndsAt: T,
  plan: "monthly",
  subscriptionStatus: "active",
  subscriptionReference: "sub_123",
  cancelAtPeriodEnd: true,
  currentPeriodEnd: T,
  lastSyncedAt: T,
  ...over,
});
const page = (items: BillingSummary[], enabled = true) => ({
  evaluatedAt: T,
  enabled,
  enforceFrom: enabled ? "2026-11-01T00:00:00.000Z" : null,
  items,
  pagination: {
    page: 1,
    limit: 25,
    total: items.length,
    pages: items.length ? 1 : 0,
  },
});

describe("Subscriptions & payments", () => {
  it("read-only list: access state, plan, trial and period wording, sync time; no money controls", async () => {
    routeFetch({
      "GET /admin/billing/accounts": json(
        200,
        page([
          row(),
          row({
            accountId: "x",
            state: "payment_issue",
            subscriptionStatus: "past_due",
            cancelAtPeriodEnd: false,
            lastSyncedAt: null,
          }),
        ]),
      ),
    });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    const table = await screen.findByRole("table", {
      name: "Billing accounts",
    });
    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(
      within(first!).getByText("Cancels at period end"),
    ).toBeInTheDocument();
    expect(within(first!).getAllByText(/^Ends /)).toHaveLength(2); // trial end and paid period (cancels)
    expect(within(second!).getByText("Payment issue")).toBeInTheDocument();
    expect(within(second!).getByText("Never")).toBeInTheDocument();
    expect(
      screen.getByText(/older accounts keep their access/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Apply filters",
    ]);
    expect(document.body.textContent).not.toMatch(
      /refund|charge|extend|mark as paid|card ending/i,
    );
  });

  it("billing off and empty states are said plainly; filters are validated", async () => {
    routeFetch({ "GET /admin/billing/accounts": json(200, page([], false)) });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    expect(
      await screen.findByText(/Billing is switched off/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No trials or subscriptions yet"),
    ).toBeInTheDocument();
    router.replace.mockClear();
    await userEvent.type(screen.getByLabelText("Subscription ID"), "price_123");
    await userEvent.click(
      screen.getByRole("button", { name: "Apply filters" }),
    );
    expect(
      await screen.findByText(/Enter a Stripe subscription ID/),
    ).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("a non-super-admin is refused by the API and told so", async () => {
    routeFetch({
      "GET /admin/billing/accounts": json(403, {
        message: "Billing details are visible to super admins only.",
      }),
    });
    renderWithClient(<AdminBillingList filters={{ page: 1 }} />);
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
  });
});
