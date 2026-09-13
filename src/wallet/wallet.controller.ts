import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { WalletService } from './wallet.service';
import { WalletTransferDto } from './dto/wallet-transfer.dto';

@Controller('wallet')
export class WalletController {
  constructor(private walletService: WalletService) {}

  // Step 1 of a wallet-to-wallet transfer — see WalletService.lookupWalletId.
  @Get('transfer/lookup')
  lookupTransferTarget(
    @CurrentUser() user: AuthenticatedUser,
    @Query('walletId') walletId: string,
  ) {
    return this.walletService.lookupWalletId(walletId, user.id);
  }

  // Step 2 — the actual transfer. See WalletService.transferToWallet.
  @Post('transfer')
  transfer(@CurrentUser() user: AuthenticatedUser, @Body() dto: WalletTransferDto) {
    const idempotencyKey = `wallet-transfer:${user.id}:${dto.toWalletId}:${dto.amount}:${Date.now()}`;
    return this.walletService.transferToWallet(
      user.id,
      { toWalletId: dto.toWalletId, amount: dto.amount, pin: dto.pin ?? '' },
      idempotencyKey,
    );
  }

  @Get('balance')
  getBalance(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getBalance(user.id);
  }

  @Get('statement')
  getStatement(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100) : 20;
    return this.walletService.getStatement(user.id, {
      limit: parsedLimit,
      cursor,
      type,
      status,
      from,
      to,
    });
  }

  // Powers the Transaction History page's "Export" button (web) and the
  // mobile transaction-history screen's export action — same filters as
  // GET /wallet/statement, but returns every matching row (up to
  // WalletService's STATEMENT_EXPORT_ROW_CAP) as a single PDF statement
  // rather than one cursor-page of JSON, so the customer gets their whole
  // filtered history in one downloadable document instead of paging through
  // it by hand. 2026-09-13: switched from CSV to PDF (Jude's request) and
  // shared as-is with mobile, which previously had no export at all.
  @Get('statement/export')
  async exportStatement(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const [rows, profile] = await Promise.all([
      this.walletService.getStatementExportRows(user.id, { type, status, from, to }),
      this.walletService.getStatementCustomerName(user.id),
    ]);

    const buffer = await this.buildStatementPdf(rows, profile);
    const filename = `payder-transactions-${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  private buildStatementPdf(
    rows: Array<{
      id: string;
      type: string;
      status: string;
      amount: { toFixed(n: number): string };
      fee: { toFixed(n: number): string };
      providerReference: string | null;
      createdAt: Date;
      completedAt: Date | null;
    }>,
    customerName: string,
  ): Promise<Buffer> {
    return new Promise((resolve) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      doc.fontSize(18).text('PAYDER', { continued: false });
      doc.fontSize(11).fillColor('#555').text('Transaction statement').moveDown(0.3);
      doc
        .fontSize(9)
        .text(`${customerName}  ·  Generated ${new Date().toLocaleString('en-NG')}  ·  ${rows.length} transaction(s)`)
        .moveDown(1);
      doc.fillColor('#000');

      const colX = { date: 40, type: 155, status: 250, amount: 340, fee: 430, ref: 510, completed: 660 };
      const headerY = doc.y;
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Date', colX.date, headerY);
      doc.text('Type', colX.type, headerY);
      doc.text('Status', colX.status, headerY);
      doc.text('Amount (NGN)', colX.amount, headerY);
      doc.text('Fee (NGN)', colX.fee, headerY);
      doc.text('Reference', colX.ref, headerY);
      doc.text('Completed', colX.completed, headerY);
      doc.moveDown(0.5);
      doc.moveTo(40, doc.y).lineTo(800, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.3);

      doc.font('Helvetica').fontSize(8.5);
      for (const t of rows) {
        if (doc.y > 520) {
          doc.addPage({ size: 'A4', margin: 40, layout: 'landscape' });
        }
        const y = doc.y;
        doc.text(t.createdAt.toLocaleString('en-NG'), colX.date, y, { width: 110 });
        doc.text(t.type, colX.type, y, { width: 90 });
        doc.text(t.status, colX.status, y, { width: 85 });
        doc.text(t.amount.toFixed(2), colX.amount, y, { width: 85 });
        doc.text(t.fee.toFixed(2), colX.fee, y, { width: 75 });
        doc.text(t.providerReference ?? '—', colX.ref, y, { width: 145 });
        doc.text(t.completedAt ? t.completedAt.toLocaleString('en-NG') : '—', colX.completed, y, {
          width: 110,
        });
        doc.moveDown(0.6);
      }

      doc.end();
    });
  }
}
