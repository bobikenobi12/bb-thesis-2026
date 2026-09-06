"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE shared, fully-custom checkout form (the project's "State 2"). Stripe's SPLIT card
// elements (Card Number / Expiry / CVC, styled by us) + our own name / address / tax-id
// fields + a derived order summary. On submit it confirms the subscription's first
// payment via stripe.confirmCardPayment(clientSecret) (cards only; 3-D Secure inline),
// then hands the collected billing details to the consumer's `onPaid` which persists them
// (standalone customer vs active org) and advances the flow. Render inside
// <StripeElementsProvider clientSecret={…}>. Reused by the create-org sheet, /onboarding,
// the upgrade-org sheet, and billing settings.

import { coerceEnum } from "@/lib/coerce";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CardCvcElement,
  CardExpiryElement,
  CardNumberElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { ChevronRight, Info, Lock, Plus, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { Controller, type UseFormReturn, useForm } from "react-hook-form";
import { z } from "zod";
import { cardElementStyle } from "@/components/billing/stripe-elements";
import {
  DEFAULT_TAX_ID_TYPE,
  TAX_ID_TYPES,
  type TaxIdType,
  taxIdOption,
} from "@/lib/billing/tax-ids";
import { formatMoney } from "@repo/format";
import type { SupportedCurrency } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { CountrySelect } from "@repo/ui/country-select";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";

/**
 * The subset of catalog display fields the checkout form actually renders (name + the
 * per-currency price + optional included credit). Both `PlanCatalogEntry` (org plans) and
 * `AiPlanCatalogEntry` (standalone AI tiers) satisfy it structurally, so the one form serves
 * org-plan checkout AND AI-subscription checkout with no duplication.
 */
export interface CheckoutMeta {
  name: string;
  priceMonthlyUsd?: number;
  priceMonthlyEur?: number;
  includedCreditUsd?: number;
  includedCreditEur?: number;
}

/** The billing details the form collects and hands back on a confirmed charge. */
export interface CollectedBilling {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  taxType: TaxIdType;
  taxValue: string;
  /** Whether to also store this address as the org's primary address. */
  useAsPrimary: boolean;
}

/**
 * The address subset of a CollectedBilling — its shape is accepted by both
 * `updateBillingAddress` / `setCustomerBillingAddress` (Stripe customer) and
 * `updateOrgPrimaryAddress` (org metadata), so checkout consumers don't re-map fields.
 */
export function billingAddressFrom(b: CollectedBilling) {
  return {
    name: b.name,
    line1: b.line1,
    line2: b.line2,
    city: b.city,
    state: b.state,
    postalCode: b.postalCode,
    country: b.country,
  };
}

const schema = z.object({
  name: z.string().trim().min(1, "Enter the cardholder name."),
  country: z.string().trim().min(2, "Select a country or region."),
  line1: z.string().trim().min(1, "Enter your address."),
  line2: z.string().trim(),
  city: z.string().trim().min(1, "Enter your city."),
  state: z.string().trim(),
  postalCode: z.string().trim().min(1, "Enter your postal code."),
  useAsPrimary: z.boolean(),
  taxType: z.custom<TaxIdType>(
    (v) => typeof v === "string" && TAX_ID_TYPES.some((t) => t.value === v),
  ),
  taxValue: z.string().trim(),
});
type FormData = z.infer<typeof schema>;

/**
 * The catalog and Stripe hand this form MAJOR units (29, 0.5); `formatMoney` takes minor ones.
 *
 * `Math.round` so a float price (29.99 * 100 is 2998.9999…) cannot land a fraction of a cent in
 * an argument documented as an integer.
 *
 * This file used to carry its own `money()`, which picked the symbol from a two-entry `€`/`$`
 * table and glued it onto `toLocaleString("en-US")`. It rendered `$29` where every other billing
 * surface renders `$29.00`, and because the symbol was a VARIABLE rather than a literal, no
 * `$`-in-front-of-an-interpolation guard could see it.
 *
 * `SupportedCurrency` is `"usd" | "eur"` — both two-decimal for charges, so the zero-decimal
 * split `formatMoney` now applies (Stripe's charge table, see `packages/format/src/minor-units.ts`)
 * resolves to a divisor of 100 either way and cannot change what this file renders. It is stated
 * as a property of the TYPE rather than of `formatMoney`, because `formatMoney` no longer has the
 * limitation this sentence used to cite — it divides by the charge divisor now, and the reason
 * this call site is safe is that its currency union cannot reach the other branch.
 */
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** ISO 4217 for `@repo/format`; `SupportedCurrency` is the lower-case Stripe spelling. */
function isoCode(currency: SupportedCurrency): string {
  return currency.toUpperCase();
}

interface BillingCheckoutFormProps {
  /** The subscription intent's client secret (confirmed here). */
  clientSecret: string;
  /** Catalog display fields — drives the name, included credit, and price copy. */
  meta: CheckoutMeta;
  /** Live per-seat price (in `currency`) from Stripe — authoritative; falls back to the catalog. */
  unitAmount?: number | null;
  /** The billing currency (drives the money formatting + fallback). */
  currency: SupportedCurrency;
  /** Owner email for the "1 member" summary row. */
  ownerEmail?: string;
  /**
   * Show the seat rows ("1 member", $0) in the order summary. True for the per-seat org
   * plan; pass false for the standalone AI subscription (no seats — it's a flat product).
   */
  showMembers?: boolean;
  submitLabel?: string;
  /**
   * When true (inside the purchase sheets), the form fills its flex parent: the fields
   * scroll and the submit button is pinned in a sticky footer. Default false → normal
   * flow (onboarding), where the button sits at the end of the fields.
   */
  scrollable?: boolean;
  /**
   * Called after the card is confirmed (charge done). The consumer persists the billing
   * details (address / tax id / primary address) and advances the view. Awaited — keep
   * the button in its processing state until it resolves; never re-charges.
   */
  onPaid: (billing: CollectedBilling) => void | Promise<void>;
}

export function BillingCheckoutForm({
  clientSecret,
  meta,
  unitAmount,
  currency,
  ownerEmail,
  showMembers = true,
  submitLabel,
  scrollable = false,
  onPaid,
}: BillingCheckoutFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const { resolvedTheme } = useTheme();
  const style = cardElementStyle(resolvedTheme === "dark");

  const [showTaxId, setShowTaxId] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      country: "",
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      useAsPrimary: true,
      taxType: DEFAULT_TAX_ID_TYPE,
      taxValue: "",
    },
    mode: "onChange",
  });

  // Stripe-authoritative seat price in the selected currency (catalog fallback while it
  // loads / offline).
  const unit =
    unitAmount ??
    (currency === "eur" ? meta.priceMonthlyEur : meta.priceMonthlyUsd) ??
    0;
  const credit =
    (currency === "eur" ? meta.includedCreditEur : meta.includedCreditUsd) ?? 0;
  // Order summary line items — base product + (per-seat plans only) the included member at $0.
  const lineItems = [
    { label: meta.name, cost: unit },
    ...(showMembers ? [{ label: "1 member", cost: 0, member: true }] : []),
  ];
  const total = lineItems.reduce((s, li) => s + li.cost, 0);
  // Minor units and the ISO code, resolved ONCE: every figure this form prints goes through
  // `formatMoney` from these three, so no two rows of the order summary can disagree about the
  // symbol, the separators or the decimals.
  const code = isoCode(currency);
  const unitCents = toCents(unit);
  const creditCents = toCents(credit);
  const totalCents = toCents(total);

  const submitting = form.formState.isSubmitting;
  const cardOptions = { style, showIcon: true } as const;

  async function onValid(values: FormData) {
    if (!stripe || !elements) return;
    const card = elements.getElement(CardNumberElement);
    if (!card) {
      form.setError("root", { message: "Card details are not ready yet." });
      return;
    }
    const result = await stripe.confirmCardPayment(clientSecret, {
      payment_method: {
        card,
        billing_details: {
          name: values.name,
          address: {
            line1: values.line1,
            line2: values.line2 || undefined,
            city: values.city,
            state: values.state || undefined,
            postal_code: values.postalCode,
            country: values.country,
          },
        },
      },
    });
    if (result.error) {
      form.setError("root", {
        message: result.error.message ?? "Your card couldn't be charged.",
      });
      return;
    }
    // Charge confirmed — hand off; the consumer persists + swaps the view. Errors
    // there are handled by the consumer (retry without re-charging).
    await onPaid({
      name: values.name,
      line1: values.line1,
      line2: values.line2 || undefined,
      city: values.city,
      state: values.state || undefined,
      postalCode: values.postalCode,
      country: values.country,
      taxType: values.taxType,
      taxValue: showTaxId ? values.taxValue : "",
      useAsPrimary: values.useAsPrimary,
    });
  }

  return (
    <TooltipProvider>
      <form
        onSubmit={form.handleSubmit(onValid)}
        className={cn("flex flex-col", scrollable ? "min-h-0 flex-1" : "gap-5")}
      >
        <div
          className={cn(
            "space-y-5",
            scrollable && "min-h-0 flex-1 overflow-y-auto pr-1",
          )}
        >
          {/* included credit */}
          {credit > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
              <div className="flex items-center gap-2 text-ui-md text-text-secondary">
                <span className="font-medium text-text-primary">
                  Included credit
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="What is included credit?"
                      >
                        <Info size={13} className="text-text-tertiary" />
                      </button>
                    }
                  />
                  <TooltipContent className="max-w-[220px]">
                    A monthly usage credit applied toward metered resources
                    (runner-minutes & AI) before any overage.
                  </TooltipContent>
                </Tooltip>
              </div>
              <span className="font-mono text-ui-md text-text-primary">
                {formatMoney(creditCents, code)}
              </span>
            </div>
          )}

          {/* card row — number full-width, expiry + cvc below */}
          <div className="space-y-2">
            <Label className="text-ui-md">Card information</Label>
            <CardField>
              <CardNumberElement options={cardOptions} />
            </CardField>
            <div className="grid grid-cols-2 gap-2">
              <CardField>
                <CardExpiryElement options={cardOptions} />
              </CardField>
              <CardField>
                <CardCvcElement options={cardOptions} />
              </CardField>
            </div>
            <p className="flex items-center gap-1.5 text-ui-xs text-text-tertiary">
              <Lock size={11} />
              You authorize Alethia to charge your card for this and future
              payments per the terms below.
            </p>
          </div>

          {/* full name */}
          <Field label="Full name" error={form.formState.errors.name?.message}>
            <Input
              placeholder="Jane Doe"
              autoComplete="name"
              {...form.register("name")}
            />
          </Field>

          {/* country */}
          <Field
            label="Country or region"
            error={form.formState.errors.country?.message}
          >
            <Controller
              control={form.control}
              name="country"
              render={({ field }) => (
                <CountrySelect
                  value={field.value}
                  onChange={field.onChange}
                  invalid={Boolean(form.formState.errors.country)}
                />
              )}
            />
          </Field>

          {/* address line 1 */}
          <Field
            label="Address line 1"
            error={form.formState.errors.line1?.message}
          >
            <Input
              placeholder="123 Main St"
              autoComplete="address-line1"
              {...form.register("line1")}
            />
          </Field>

          {/* address line 2 (optional) */}
          <Field label="Address line 2" optional>
            <Input
              placeholder="Suite, unit, floor"
              autoComplete="address-line2"
              {...form.register("line2")}
            />
          </Field>

          {/* city + postal code */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="City" error={form.formState.errors.city?.message}>
              <Input
                placeholder="Berlin"
                autoComplete="address-level2"
                {...form.register("city")}
              />
            </Field>
            <Field
              label="Postal code"
              error={form.formState.errors.postalCode?.message}
            >
              <Input
                placeholder="10115"
                autoComplete="postal-code"
                {...form.register("postalCode")}
              />
            </Field>
          </div>

          {/* state / province (optional) */}
          <Field label="State / province" optional>
            <Input
              placeholder="Optional"
              autoComplete="address-level1"
              {...form.register("state")}
            />
          </Field>

          {/* use as primary address */}
          <Controller
            control={form.control}
            name="useAsPrimary"
            render={({ field }) => (
              <label className="flex items-center gap-2.5 text-ui-sm text-text-secondary">
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
                Use the billing address as my team&apos;s primary address
              </label>
            )}
          />

          {/* tax id — optional disclosure */}
          <TaxIdSection
            show={showTaxId}
            onShow={() => setShowTaxId(true)}
            onHide={() => {
              setShowTaxId(false);
              form.setValue("taxValue", "");
            }}
            form={form}
          />

          {/* legal paragraph */}
          <p className="text-ui-xs leading-relaxed text-text-tertiary">
            By clicking {submitLabel ?? "Create"}, you authorize a charge of{" "}
            {formatMoney(totalCents, code)} now and the same amount each month until
            you cancel. Any applicable tax is estimated and finalized on your
            invoice.
          </p>

          {/* order summary */}
          <div className="rounded-lg border border-border">
            {/* header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5 font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
              <span>Product</span>
              <span>Cost</span>
            </div>

            {/* plan row */}
            <div className="flex items-center justify-between px-4 py-3 text-ui-sm">
              <span className="font-medium text-text-primary">{meta.name}</span>
              <span className="font-mono text-ui-sm text-text-secondary">
                {formatMoney(unitCents, code)}
              </span>
            </div>

            {/* member row — collapsible (per-seat plans only) */}
            {showMembers && (
              <div className="border-t border-border">
                <button
                  type="button"
                  onClick={() => setMembersExpanded((v) => !v)}
                  className="flex w-full items-center justify-between px-4 py-3 text-ui-sm"
                >
                  <span className="flex items-center gap-1.5 text-text-secondary">
                    <ChevronRight
                      size={14}
                      className={cn(
                        "text-text-tertiary transition-transform",
                        membersExpanded && "rotate-90",
                      )}
                    />
                    1 member
                  </span>
                  <span className="font-mono text-ui-sm text-text-secondary">
                    {formatMoney(0, code)}
                  </span>
                </button>
                {membersExpanded && ownerEmail && (
                  <div className="flex items-center justify-between px-4 pb-3 pl-[34px] text-ui-xs text-text-tertiary">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{ownerEmail}</span>
                      <span className="rounded-full border border-border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
                        Owner
                      </span>
                    </span>
                    <span className="font-mono text-ui-2xs">Included</span>
                  </div>
                )}
              </div>
            )}

            {/* total — below divider, right-aligned */}
            <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-3">
              <span className="text-ui-md font-medium text-text-primary">
                Total
              </span>
              <span className="font-display text-ui-xl font-semibold text-text-primary">
                {formatMoney(totalCents, code)}
                <span className="font-mono text-ui-xs font-normal text-text-tertiary">
                  {" "}
                  / month
                </span>
              </span>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "space-y-3",
            scrollable && "shrink-0 border-t border-border bg-background pt-4",
          )}
        >
          {form.formState.errors.root?.message && (
            <p className="text-ui-sm text-destructive">
              {form.formState.errors.root.message}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={!stripe || submitting}
          >
            {submitting
              ? "Processing…"
              : (submitLabel ?? `Create — ${formatMoney(totalCents, code)}`)}
          </Button>
        </div>
      </form>
    </TooltipProvider>
  );
}

/** The optional Tax ID block — a link until opened, then a type selector + value input. */
function TaxIdSection({
  show,
  onShow,
  onHide,
  form,
}: {
  show: boolean;
  onShow: () => void;
  onHide: () => void;
  form: UseFormReturn<FormData>;
}) {
  if (!show) {
    return (
      <button
        type="button"
        onClick={onShow}
        className="flex items-center gap-1.5 text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        <Plus size={13} />
        Add a tax ID
      </button>
    );
  }
  const taxType = form.watch("taxType");
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-ui-md font-medium text-text-primary">
          Tax ID
        </span>
        <button
          type="button"
          onClick={onHide}
          aria-label="Remove tax ID"
          className="flex items-center gap-1 font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary transition-colors hover:text-text-primary"
        >
          <X size={12} />
          Remove
        </button>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-2">
        <Controller
          control={form.control}
          name="taxType"
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(v) =>
                field.onChange(
                  coerceEnum(
                    v,
                    TAX_ID_TYPES.map((t) => t.value),
                    DEFAULT_TAX_ID_TYPE,
                  ),
                )
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TAX_ID_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <Input
          placeholder={taxIdOption(taxType).example}
          autoComplete="off"
          {...form.register("taxValue")}
        />
      </div>
    </div>
  );
}

/** A bordered shell that frames a Stripe split-card element like our text inputs. */
function CardField({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center rounded-sm border border-input bg-transparent px-3 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 [&>*]:w-full">
      {children}
    </div>
  );
}

/** A labeled field with an optional error / optional badge. */
function Field({
  label,
  optional,
  error,
  children,
}: {
  label: string;
  optional?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-ui-md font-medium text-text-primary">
        {label}
        {optional && (
          <span className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
            optional
          </span>
        )}
      </div>
      {children}
      {error && <p className="text-ui-xs text-destructive">{error}</p>}
    </div>
  );
}
