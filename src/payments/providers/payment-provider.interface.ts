/**
 * Every payment rail (Paystack, Flutterwave, and any future one) implements
 * this. Nothing outside the payments module should import Paystack- or
 * Flutterwave-specific types directly — that's what makes it possible to add
 * a third provider or fail over between the two without touching business
 * logic (see architecture doc §6).
 */
export interface InitializeFundingResult {
  authorizationUrl?: string; // for redirect-based checkout
  virtualAccountNumber?: string;
  virtualAccountBank?: string;
  reference: string;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  event?: string;
  reference?: string;
  amount?: string;
  currency?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: 'paystack' | 'flutterwave';

  createDedicatedVirtualAccount(params: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<{ accountNumber: string; bankName: string }>;

  initializeCardCharge(params: {
    userId: string;
    email: string;
    amount: string;
    reference: string;
  }): Promise<InitializeFundingResult>;

  /**
   * Verifies an inbound webhook's signature against the raw request body.
   * MUST be called before trusting any webhook payload — never act on a
   * webhook's claimed status without this (see architecture doc §8).
   */
  verifyWebhookSignature(
    signatureHeader: string | undefined,
    rawBody: Buffer | string,
  ): WebhookVerificationResult;
}
