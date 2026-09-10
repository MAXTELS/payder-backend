import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SupportService } from './support.service';
import { PostUtmeAssistDto } from './dto/post-utme-assist.dto';

@Controller('support')
export class SupportController {
  constructor(private supportService: SupportService) {}

  @Post('tickets')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body('category') category: string,
    @Body('message') message: string,
  ) {
    return this.supportService.createTicket(user.id, category, message);
  }

  // §5.5 — dedicated endpoint for the assisted Post-UTME registration form,
  // rather than making customers hand-write a category/message pair for
  // something with several required fields.
  @Post('post-utme-assist')
  createPostUtmeAssist(@CurrentUser() user: AuthenticatedUser, @Body() dto: PostUtmeAssistDto) {
    return this.supportService.createPostUtmeAssistTicket(user.id, dto);
  }

  @Get('tickets/mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.supportService.listMyTickets(user.id);
  }

  @Roles('CUSTOMER_CARE', 'ADMIN')
  @Get('tickets/queue')
  queue(@CurrentUser() user: AuthenticatedUser) {
    return this.supportService.listQueue(user.id);
  }

  @Roles('CUSTOMER_CARE', 'ADMIN')
  @Post('tickets/:id/reply')
  reply(
    @Param('id') ticketId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body('body') body: string,
  ) {
    return this.supportService.reply(ticketId, user.id, body);
  }
}
