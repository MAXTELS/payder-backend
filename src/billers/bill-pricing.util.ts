import { BadRequestException } from '@nestjs/common';

/**
 * Shared pure logic for the biller bill-builder + the customer/guest bill-pay
 * flow — used by BillersService (build/edit/publish) and BillerPaymentsService
 * (compute what a customer owes). Kept dependency-free (no Prisma) so both
 * modules can import it without creating a cycle between billers/ and the new
 * biller-payments/ module.
 */

export type BillFieldType = 'TEXT' | 'SELECT';

export interface BillFieldDefinition {
  key: string; // e.g. "regNo", "department", "level", "phone"
  label: string; // e.g. "Registration number"
  type: BillFieldType;
  options?: string[]; // required (and only meaningful) when type === 'SELECT'
}

export interface BillDefinitionShape {
  fields: BillFieldDefinition[];
  pricingMode: 'FLAT' | 'PER_COMBINATION';
  flatAmount?: string | number | null;
  pricingTable?: Record<string, string | number> | null;
}

/**
 * 2026-09-13: was a flat ₦110 regardless of bill amount. Per Jude's
 * app-wide fee restructure, the "School fees & other billers" marketplace
 * (this is the "other school-due billers and contributions billers" bucket
 * — distinct from the separate Remita/eTranzact flow, which has its own
 * flat+% fee in ManualPaymentsService.remitaPortalFee) now charges flat
 * ₦100 + 0.5% of the bill amount, with the TOTAL fee capped at ₦1,500 even
 * on a very large bill. Kept as a function (not a constant) since the fee
 * now depends on the amount — see computePortalFee below. No ConfigService
 * here (this file is deliberately dependency-free, see the file header),
 * so env overrides read straight from process.env like everywhere else in
 * this file would if it needed them — same names Nest's ConfigService
 * would resolve, since it also reads from process.env underneath.
 */
export function computePortalFee(billAmount: number): number {
  const flat = Number(process.env.BILLER_PORTAL_FLAT_FEE ?? '100');
  const percent = Number(process.env.BILLER_PORTAL_PERCENT_FEE ?? '0.5');
  const cap = Number(process.env.BILLER_PORTAL_FEE_CAP ?? '1500');
  const fee = flat + (billAmount * percent) / 100;
  return Math.min(Math.round(fee * 100) / 100, cap);
}

/** Validates the shape of a bill's field list (used on every save, draft or not). */
export function validateFieldsShape(fields: unknown): asserts fields is BillFieldDefinition[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new BadRequestException('A bill needs at least one data field');
  }
  const seenKeys = new Set<string>();
  for (const f of fields) {
    if (!f || typeof f !== 'object') throw new BadRequestException('Invalid field definition');
    const field = f as Record<string, unknown>;
    if (typeof field.key !== 'string' || !field.key.trim()) {
      throw new BadRequestException('Every field needs a key');
    }
    if (seenKeys.has(field.key)) {
      throw new BadRequestException(`Duplicate field key: ${field.key}`);
    }
    seenKeys.add(field.key);
    if (typeof field.label !== 'string' || !field.label.trim()) {
      throw new BadRequestException(`Field "${field.key}" needs a label`);
    }
    if (field.type !== 'TEXT' && field.type !== 'SELECT') {
      throw new BadRequestException(`Field "${field.key}" type must be TEXT or SELECT`);
    }
    if (field.type === 'SELECT') {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        throw new BadRequestException(
          `Field "${field.key}" is a SELECT field and needs at least one option (e.g. each department, or each level)`,
        );
      }
      const opts = field.options as unknown[];
      if (opts.some((o) => typeof o !== 'string' || !o.trim())) {
        throw new BadRequestException(`Field "${field.key}" has an empty option value`);
      }
    }
  }
}

/** The SELECT fields, in the bill's declared order — this order is what a
 * pricing-table key's "value1|value2" segments correspond to. */
export function selectFieldsOf(fields: BillFieldDefinition[]): BillFieldDefinition[] {
  return fields.filter((f) => f.type === 'SELECT');
}

/** Every possible combination key for a bill's SELECT fields, e.g. for
 * department x level: "Computer Science|100L", "Computer Science|200L", ... */
export function allCombinationKeys(fields: BillFieldDefinition[]): string[] {
  const selects = selectFieldsOf(fields);
  if (selects.length === 0) return [];
  let combos: string[][] = [[]];
  for (const field of selects) {
    const next: string[][] = [];
    for (const combo of combos) {
      for (const opt of field.options ?? []) {
        next.push([...combo, opt]);
      }
    }
    combos = next;
  }
  return combos.map((c) => c.join('|'));
}

/**
 * Validates a bill definition is ready to publish: FLAT needs flatAmount;
 * PER_COMBINATION needs every combination of its SELECT fields' options
 * priced (the confirmed "price per combination" decision — a biller can set
 * one amount for all combinations by just repeating the same value across
 * the table, so the UI can offer bulk-fill and this validation stays the same
 * either way).
 */
export function validatePricingComplete(def: BillDefinitionShape): void {
  if (def.pricingMode === 'FLAT') {
    const amount = Number(def.flatAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Set a flat amount before publishing');
    }
    return;
  }

  // PER_COMBINATION
  const keys = allCombinationKeys(def.fields);
  if (keys.length === 0) {
    throw new BadRequestException(
      'Per-combination pricing needs at least one SELECT field (e.g. department or level) with options',
    );
  }
  const table = def.pricingTable ?? {};
  const missing = keys.filter((k) => {
    const v = Number((table as Record<string, unknown>)[k]);
    return !Number.isFinite(v) || v <= 0;
  });
  if (missing.length > 0) {
    throw new BadRequestException(
      `Set a price for every combination before publishing (missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})`,
    );
  }
}

/** Validates a customer/guest's submitted answers against the bill's fields —
 * every field must be answered, and a SELECT answer must be one of its
 * declared options. */
export function validateFieldValues(
  fields: BillFieldDefinition[],
  fieldValues: Record<string, string>,
): void {
  for (const field of fields) {
    const value = fieldValues?.[field.key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`"${field.label}" is required`);
    }
    if (field.type === 'SELECT' && !(field.options ?? []).includes(value)) {
      throw new BadRequestException(`"${value}" is not a valid option for "${field.label}"`);
    }
  }
}

/** Resolves what a customer/guest owes for their submitted answers —
 * FLAT is just flatAmount; PER_COMBINATION looks up the SELECT fields'
 * answers (joined in field-declaration order) in the pricing table. Assumes
 * validateFieldValues has already passed. */
export function resolveBillAmount(
  def: BillDefinitionShape,
  fieldValues: Record<string, string>,
): number {
  if (def.pricingMode === 'FLAT') {
    return Number(def.flatAmount);
  }
  const selects = selectFieldsOf(def.fields);
  const key = selects.map((f) => fieldValues[f.key]).join('|');
  const amount = Number((def.pricingTable ?? {})[key]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestException('No price is set for this combination of selections');
  }
  return amount;
}
