import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SupportService {
  constructor(private prisma: PrismaService) {}

  createTicket(customerId: string, category: string, message: string, metadata?: object) {
    return this.prisma.supportTicket.create({
      data: {
        customerId,
        category,
        metadata,
        messages: { create: { authorId: customerId, body: message } },
      },
      include: { messages: true },
    });
  }

  /**
   * §5.5 — Post-UTME can't be automated (no per-institution API), so this
   * just turns the customer's structured intake into a `post_utme_assist`
   * ticket with the fields an agent needs preserved in `metadata`, and a
   * readable summary as the opening message so the existing ticket UI (queue,
   * reply) needs no special-casing to handle it.
   */
  createPostUtmeAssistTicket(
    customerId: string,
    dto: { institutionName: string; jambRegNumber: string; programme: string; notes?: string },
  ) {
    const summary =
      `Post-UTME assistance requested.\n` +
      `Institution: ${dto.institutionName}\n` +
      `JAMB reg number: ${dto.jambRegNumber}\n` +
      `Programme: ${dto.programme}` +
      (dto.notes ? `\nNotes: ${dto.notes}` : '');

    return this.createTicket(customerId, 'post_utme_assist', summary, {
      institutionName: dto.institutionName,
      jambRegNumber: dto.jambRegNumber,
      programme: dto.programme,
      notes: dto.notes ?? null,
    });
  }

  listMyTickets(customerId: string) {
    return this.prisma.supportTicket.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Customer-care queue: unassigned + assigned-to-me tickets. Full PII
  // (BVN/NIN) is masked at the query layer here in the real implementation —
  // see architecture doc §10 — this scaffold just returns ticket data.
  listQueue(agentId: string) {
    return this.prisma.supportTicket.findMany({
      where: { OR: [{ assignedAgentId: null }, { assignedAgentId: agentId }] },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async reply(ticketId: string, agentId: string, body: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new ForbiddenException('Ticket not found');

    return this.prisma.ticketMessage.create({
      data: { ticketId, authorId: agentId, body },
    });
  }
}
