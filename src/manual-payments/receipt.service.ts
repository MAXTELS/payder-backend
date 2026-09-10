import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { ManualPaymentRequest } from '@prisma/client';

const RECEIPTS_DIR = path.join(process.cwd(), 'storage', 'receipts');

/**
 * Generates the PDF receipt for a manual invoice payment (§5.4b) once an
 * admin marks it paid. Kept intentionally simple — one page, no logo/brand
 * assets — since the point right now is a real, working receipt that proves
 * the flow end to end, not final visual design.
 *
 * Receipts are written to local disk under storage/receipts/ (gitignored).
 * That's fine for local dev and even a single-box deployment; once real
 * infrastructure is chosen (§8/§13 — AWS), swap the write below for an S3
 * PutObject and store the resulting key/URL instead of a local path.
 */
@Injectable()
export class ReceiptService {
  async generateManualPaymentReceipt(
    request: ManualPaymentRequest & { user: { firstName: string; lastName: string; email: string } },
  ): Promise<{ buffer: Buffer; relativePath: string }> {
    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));

    const done = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    doc.fontSize(20).text('PAYDER', { continued: false });
    doc.fontSize(12).fillColor('#555').text('Payment Receipt').moveDown(1.5);
    doc.fillColor('#000');

    doc.fontSize(10);
    const row = (label: string, value: string) => {
      doc.font('Helvetica-Bold').text(label, { continued: true, width: 160 });
      doc.font('Helvetica').text(value);
    };

    row('Receipt for:', `${request.user.firstName} ${request.user.lastName} (${request.user.email})`);
    row('Biller:', request.biller);
    row('Invoice reference:', request.invoiceReference);
    if (request.payerName) row('Payer name:', request.payerName);
    if (request.description) row('Description:', request.description);
    row('Amount:', `NGN ${Number(request.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`);
    row('Provider confirmation ref:', request.providerConfirmationRef ?? '—');
    row('Request ID:', request.id);
    row('Paid on:', (request.resolvedAt ?? new Date()).toISOString());

    doc.moveDown(2);
    doc
      .fontSize(9)
      .fillColor('#777')
      .text(
        'This invoice was paid on your behalf by a PAYDER admin via the manual invoice-payment ' +
          'flow (interim process, pending direct biller integration). Keep this receipt for your records.',
        { width: 480 },
      );

    doc.end();
    const buffer = await done;

    const filename = `${request.id}.pdf`;
    const fullPath = path.join(RECEIPTS_DIR, filename);
    fs.writeFileSync(fullPath, buffer);

    return { buffer, relativePath: `/receipts/${filename}` };
  }

  readReceiptFile(relativePath: string): Buffer {
    const filename = path.basename(relativePath);
    return fs.readFileSync(path.join(RECEIPTS_DIR, filename));
  }
}
