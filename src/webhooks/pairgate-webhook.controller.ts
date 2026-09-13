import { Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PairgateWebhookService } from './pairgate-webhook.service';

// Verified against Pairgate's raw request body — same global
// express.json({ verify }) hook in main.ts already used for the Paystack/
// Flutterwave webhooks (req.rawBody), no main.ts changes needed for this
// route to get it too.
@Controller('webhooks')
export class PairgateWebhookController {
  constructor(private webhookService: PairgateWebhookService) {}

  @Public()
  @Post('pairgate')
  async pairgateWebhook(
    @Headers('x-pairgate-signature') signature: string | undefined,
    @Headers('x-pairgate-timestamp') timestamp: string | undefined,
    @Req() req: Request,
  ) {
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
    const result = this.webhookService.verifySignature(signature, timestamp, rawBody);
    if (!result.isValid) throw new UnauthorizedException('Invalid webhook signature');
    return this.webhookService.handle(result.payload);
  }
}
