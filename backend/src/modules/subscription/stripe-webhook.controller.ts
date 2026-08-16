import { Controller, Post, Headers, Req, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../../common';
import { SubscriptionService } from './subscription.service';

@ApiTags('Subscriptions')
@Controller('subscriptions/webhook')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook listener (Hackathon Unlocked Mode)' })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleStripeWebhook(
    @Headers('stripe-signature') _signature: string,
    @Req() _req: { body: Buffer },
  ) {
    this.logger.log('Stripe webhook received - All hackathon features are 100% unlocked');
    return { received: true };
  }
}
