import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private walletService: WalletService) {}

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

  // Powers the Transaction History page's "Export CSV" button — same
  // filters as GET /wallet/statement, but returns every matching row (up to
  // WalletService's STATEMENT_EXPORT_ROW_CAP) as a single CSV file rather
  // than one cursor-page of JSON, so the customer gets their whole filtered
  // history in one download instead of paging through it by hand.
  @Get('statement/export')
  async exportStatement(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const rows = await this.walletService.getStatementExportRows(user.id, {
      type,
      status,
      from,
      to,
    });

    const header = [
      'Date',
      'Type',
      'Status',
      'Amount (NGN)',
      'Fee (NGN)',
      'Reference',
      'Details',
      'Completed At',
    ];
    const csvRows = [header, ...rows.map((t) => this.toCsvRow(t))];
    const csv = csvRows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');

    const filename = `payder-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  private toCsvRow(t: {
    id: string;
    type: string;
    status: string;
    amount: { toFixed(n: number): string };
    fee: { toFixed(n: number): string };
    providerReference: string | null;
    metadata: unknown;
    createdAt: Date;
    completedAt: Date | null;
  }): string[] {
    return [
      t.createdAt.toISOString(),
      t.type,
      t.status,
      t.amount.toFixed(2),
      t.fee.toFixed(2),
      t.providerReference ?? '',
      t.metadata ? JSON.stringify(t.metadata) : '',
      t.completedAt ? t.completedAt.toISOString() : '',
    ];
  }
}

function escapeCsvField(value: string): string {
  // Quote any field containing a comma, quote, or newline, doubling
  // embedded quotes — standard CSV escaping (RFC 4180).
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
