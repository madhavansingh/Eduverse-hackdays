import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

export interface UserSubscription {
  id: string;
  userId: string;
  plan: 'free' | 'monthly' | 'yearly' | 'pro' | 'enterprise';
  status: 'active' | 'canceled' | 'past_due' | 'trialing';
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  async getSubscription(userId: string): Promise<UserSubscription> {
    return {
      id: `sub-hackathon-${userId}`,
      userId,
      plan: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getOrCreateSubscription(userId: string, email?: string): Promise<UserSubscription> {
    return this.getSubscription(userId);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async isPro(_userId: string): Promise<boolean> {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async checkAndIncrementUsage(_userId: string, _type?: string, _count = 1): Promise<boolean> {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async checkStorageQuota(_userId: string, _size?: number): Promise<boolean> {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async verifyCheckoutSession(_sessionId: string): Promise<{ success: boolean; plan: string }> {
    return { success: true, plan: 'pro' };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async checkUsage(
    _userId: string,
    _type?: string,
  ): Promise<{ allowed: boolean; remaining: number }> {
    return { allowed: true, remaining: 999999 };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createCheckoutSession(
    _userId: string,
    _plan: string,
    returnUrl?: string,
  ): Promise<{ url: string }> {
    return {
      url:
        returnUrl ||
        `${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173'}/dashboard`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createPortalSession(_userId: string, returnUrl?: string): Promise<{ url: string }> {
    return {
      url:
        returnUrl ||
        `${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173'}/dashboard`,
    };
  }

  async cancelSubscription(userId: string): Promise<UserSubscription> {
    return this.getSubscription(userId);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async hasFeatureAccess(_userId: string, _feature: string): Promise<boolean> {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async checkLimit(
    _userId: string,
    _limitType: string,
  ): Promise<{ allowed: boolean; remaining: number }> {
    return { allowed: true, remaining: 999999 };
  }
}
