import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { VtuProvider, VtuPurchaseResult } from './vtu-provider.interface';

/**
 * VTpass covers airtime, data, TV, electricity, and — importantly for
 * PAYDER's exam-services feature — WAEC result-checker pins and JAMB e-PIN
 * vending (confirmed against https://vtpass.com/documentation/). NECO is
 * NOT confirmed on VTpass as of this writing; see architecture doc §5.3/§5.5
 * — treat NECO as a Phase 2 item pending a specific aggregator confirmation.
 */
@Injectable()
export class VtpassProvider implements VtuProvider {
  readonly name = 'vtpass';
  private readonly logger = new Logger(VtpassProvider.name);

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private get baseUrl() {
    return this.config.get<string>('VTPASS_BASE_URL');
  }

  private authHeaders() {
    return {
      'api-key': this.config.get<string>('VTPASS_API_KEY'),
      'secret-key': this.config.get<string>('VTPASS_SECRET_KEY'),
    };
  }

  async verifyCustomer(params: { serviceId: string; customerId: string }) {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/merchant-verify`,
          { serviceID: params.serviceId, billersCode: params.customerId },
          { headers: this.authHeaders() },
        ),
      );
      const content = res.data?.content;
      return { valid: !!content, customerName: content?.Customer_Name };
    } catch (err) {
      this.logger.error(`VTpass verifyCustomer failed: ${(err as Error).message}`);
      return { valid: false };
    }
  }

  async purchase(params: {
    requestId: string;
    serviceId: string;
    variationCode?: string;
    customerId: string;
    amount: string;
    phone: string;
  }): Promise<VtuPurchaseResult> {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/pay`,
          {
            request_id: params.requestId,
            serviceID: params.serviceId,
            variation_code: params.variationCode,
            billersCode: params.customerId,
            amount: params.amount,
            phone: params.phone,
          },
          { headers: this.authHeaders() },
        ),
      );
      return this.mapResponse(res.data);
    } catch (err) {
      this.logger.error(`VTpass purchase failed: ${(err as Error).message}`);
      return {
        status: 'failed',
        providerReference: params.requestId,
        message: (err as Error).message,
      };
    }
  }

  async requery(providerReference: string): Promise<VtuPurchaseResult> {
    const res = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/requery`,
        { request_id: providerReference },
        { headers: this.authHeaders() },
      ),
    );
    return this.mapResponse(res.data);
  }

  private mapResponse(data: any): VtuPurchaseResult {
    // VTpass responses vary by product; this normalizes the common shape.
    // code "000" = delivered, "016" = pending/processing per VTpass docs.
    const code = data?.code;
    const status = code === '000' ? 'success' : code === '016' ? 'pending' : 'failed';
    return {
      status,
      providerReference: data?.requestId ?? data?.request_id,
      message: data?.response_description,
      pin: data?.purchased_code || data?.token,
    };
  }
}
