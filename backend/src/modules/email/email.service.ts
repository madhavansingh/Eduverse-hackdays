import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

export interface EmailOptions {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface EmailLog {
  id: string;
  userId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  from: string;
  subject: string;
  status: 'sent' | 'failed' | 'pending';
  messageId?: string;
  error?: string;
  sentAt?: Date;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly appUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly db: DatabaseService,
  ) {
    this.appUrl =
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('APP_URL', 'http://localhost:5173');
  }

  async sendEmail(
    options: EmailOptions,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const to = Array.isArray(options.to) ? options.to : [options.to];
    const messageId = `local-email-${Date.now()}`;

    this.logger.log(`[Email Log] To: ${to.join(', ')} | Subject: ${options.subject}`);

    await this.logEmail({
      userId: options.userId,
      to,
      from: options.from || this.configService.get('EMAIL_DEFAULT_FROM', 'noreply@eduverse.com'),
      subject: options.subject,
      status: 'sent',
      messageId,
      sentAt: new Date(),
      metadata: options.metadata,
    });

    return { success: true, messageId };
  }

  async sendSimpleEmail(
    to: string | string[],
    subject: string,
    content: { text?: string; html?: string },
    options?: { from?: string; userId?: string },
  ) {
    return this.sendEmail({
      to,
      subject,
      text: content.text,
      html: content.html,
      from: options?.from,
      userId: options?.userId,
    });
  }

  async sendVerificationEmail(email: string, token: string, userId?: string): Promise<boolean> {
    const verifyUrl = `${this.appUrl}/verify-email?token=${token}`;
    const result = await this.sendEmail({
      to: email,
      subject: 'Verify Your Eduverse Account',
      text: `Please verify your email: ${verifyUrl}`,
      userId,
      metadata: { type: 'verification', token },
    });
    return result.success;
  }

  async sendPasswordResetEmail(email: string, token: string, userId?: string): Promise<boolean> {
    const resetUrl = `${this.appUrl}/reset-password?token=${token}`;
    const result = await this.sendEmail({
      to: email,
      subject: 'Reset Your Eduverse Password',
      text: `Reset your password: ${resetUrl}`,
      userId,
      metadata: { type: 'password_reset', token },
    });
    return result.success;
  }

  async sendWelcomeEmail(email: string, name: string, userId?: string): Promise<boolean> {
    const result = await this.sendEmail({
      to: email,
      subject: `Welcome to Eduverse, ${name}!`,
      text: `Welcome to Eduverse! Get started at ${this.appUrl}`,
      userId,
      metadata: { type: 'welcome' },
    });
    return result.success;
  }

  private async logEmail(data: Omit<EmailLog, 'id' | 'createdAt'>): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO email_logs (
          user_id, "to", cc, bcc, "from", subject,
          status, message_id, error, sent_at, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
        [
          data.userId || null,
          data.to,
          data.cc || null,
          data.bcc || null,
          data.from,
          data.subject,
          data.status,
          data.messageId || null,
          data.error || null,
          data.sentAt || null,
          data.metadata ? JSON.stringify(data.metadata) : null,
        ],
      );
    } catch {
      // Non-critical logging failure
    }
  }

  isReady(): boolean {
    return true;
  }

  getConfiguration() {
    return { provider: 'Local Console Log', ready: true };
  }
}
