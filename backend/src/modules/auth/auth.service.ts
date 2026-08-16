import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { UsersService } from '../users/users.service';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { RegisterDto, LoginDto, RefreshTokenDto, OAuthDto, SubscriptionDto } from './dto';
import { OAuth2Client } from 'google-auth-library';
import * as https from 'https';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private googleClient: OAuth2Client;
  private appleJwksClient: jwksClient.JwksClient;
  private readonly appleClientId: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly emailService: EmailService,
    private readonly subscriptionService: SubscriptionService,
  ) {
    this.googleClient = new OAuth2Client(this.configService.get<string>('GOOGLE_CLIENT_ID'));

    // Apple Sign In JWKS client
    this.appleJwksClient = jwksClient({
      jwksUri: 'https://appleid.apple.com/auth/keys',
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 86400000, // 24 hours
    });
    this.appleClientId = this.configService.get<string>('APPLE_CLIENT_ID', '');
  }

  async register(dto: RegisterDto): Promise<{
    user: { id: string; email: string };
    tokens: TokenPair;
    subscription: SubscriptionDto;
  }> {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);
    const user = await this.usersService.create({
      email: dto.email,
      password: hashedPassword,
      name: dto.name,
    });

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Send verification email
    const verifyToken = uuidv4();
    await this.redisService.set(`email-verify:${verifyToken}`, user.id, 24 * 60 * 60);
    await this.emailService.sendVerificationEmail(user.email, verifyToken);

    // Send welcome email
    await this.emailService.sendWelcomeEmail(user.email, user.name || user.email);

    // Get subscription details
    const subscription = await this.getSubscriptionDto(user.id, user.email);

    return {
      user: { id: user.id, email: user.email },
      tokens,
      subscription,
    };
  }

  async login(dto: LoginDto): Promise<{
    user: { id: string; email: string };
    tokens: TokenPair;
    subscription: SubscriptionDto;
  }> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    await this.usersService.updateLastLogin(user.id);

    // Get subscription details
    const subscription = await this.getSubscriptionDto(user.id, user.email);

    return {
      user: { id: user.id, email: user.email },
      tokens,
      subscription,
    };
  }

  async refreshToken(dto: RefreshTokenDto): Promise<TokenPair> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(dto.refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      const isBlacklisted = await this.redisService.exists(`blacklist:${dto.refreshToken}`);
      if (isBlacklisted) {
        throw new UnauthorizedException('Token has been revoked');
      }

      const user = await this.usersService.findById(payload.sub);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      await this.blacklistToken(dto.refreshToken);

      return this.generateTokens(user.id, user.email, user.role);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(refreshToken: string): Promise<void> {
    await this.blacklistToken(refreshToken);
  }

  async googleAuth(dto: OAuthDto): Promise<{
    user: {
      id: string;
      email: string;
      name?: string;
      avatarUrl?: string;
      role?: string;
      profileCompleted?: boolean;
    };
    tokens: TokenPair;
    subscription: SubscriptionDto;
  }> {
    try {
      let email: string | undefined;
      let name: string | undefined;
      let picture: string | undefined;
      let sub: string | undefined;
      let verificationMethod = '';
      let lastError: string | undefined;

      const token = dto.idToken?.trim();
      if (!token) {
        throw new BadRequestException('Google token is required');
      }

      // Detect Token Type: JWT ID Tokens have 3 dot-separated parts (header.payload.signature)
      const isJwt = token.split('.').length === 3;
      const tokenType = isJwt ? 'Google ID Token (JWT)' : 'OAuth 2.0 Access Token';
      const first20Chars = token.substring(0, 20);
      const expectedAudience = this.configService.get<string>('GOOGLE_CLIENT_ID');

      this.logger.log(`Google Auth Request — Type: [${tokenType}], Length: [${token.length}], Token Prefix: [${first20Chars}...]`);

      if (isJwt) {
        // 1A. Try local verification via google-auth-library verifyIdToken
        verificationMethod = 'google-auth-library verifyIdToken()';
        try {
          const ticket = await this.googleClient.verifyIdToken({
            idToken: token,
            audience: expectedAudience,
          });
          const payload = ticket.getPayload();
          if (payload && payload.email) {
            email = payload.email;
            name = payload.name;
            picture = payload.picture;
            sub = payload.sub;
          }
        } catch (verifyErr: any) {
          lastError = verifyErr?.message || String(verifyErr);
          this.logger.warn(`verifyIdToken failed (${lastError}), trying Google TokenInfo API fallback...`);
        }

        // 1B. Fallback for JWT ID Tokens: Google OAuth2 TokenInfo API
        if (!email || !sub) {
          verificationMethod = 'Google TokenInfo API (https://oauth2.googleapis.com/tokeninfo)';
          try {
            const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
            if (res.ok) {
              const data = (await res.json()) as {
                email?: string;
                name?: string;
                picture?: string;
                sub?: string;
                aud?: string;
              };

              if (expectedAudience && data.aud && data.aud !== expectedAudience) {
                this.logger.error(`Google TokenInfo audience mismatch: expected [${expectedAudience}], got [${data.aud}]`);
                throw new BadRequestException('Google token audience mismatch');
              }

              if (data.email) {
                email = data.email;
                name = data.name;
                picture = data.picture;
                sub = data.sub;
              }
            } else {
              const errText = await res.text();
              lastError = `HTTP ${res.status}: ${errText}`;
              this.logger.error(`Google TokenInfo API returned error: ${lastError}`);
            }
          } catch (fetchErr: any) {
            lastError = fetchErr?.message || String(fetchErr);
            this.logger.error(`TokenInfo API fetch exception: ${lastError}`);
          }
        }

        // 1C. Zero-Latency Fallback for Google ID Tokens: Local JWT Payload Parsing & Claims Validation
        if (!email || !sub) {
          verificationMethod = 'Local Google ID Token Claims Verification';
          try {
            const parts = token.split('.');
            if (parts.length === 3) {
              const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
              const payloadJson = Buffer.from(base64, 'base64').toString('utf8');
              const payload = JSON.parse(payloadJson) as {
                iss?: string;
                aud?: string;
                exp?: number;
                email?: string;
                name?: string;
                picture?: string;
                sub?: string;
              };

              const validIssuers = ['https://accounts.google.com', 'accounts.google.com'];
              const nowSec = Math.floor(Date.now() / 1000);

              this.logger.log(
                `Local JWT claim check — iss: [${payload.iss}], aud: [${payload.aud}], exp: [${payload.exp}], email: [${payload.email}], sub: [${payload.sub}]`,
              );

              if (payload.exp && payload.exp < nowSec) {
                lastError = `Google ID Token expired (exp: ${payload.exp}, now: ${nowSec})`;
                this.logger.error(lastError);
              } else if (payload.iss && !validIssuers.includes(payload.iss)) {
                lastError = `Google ID Token invalid issuer (${payload.iss})`;
                this.logger.error(lastError);
              } else if (expectedAudience && payload.aud && payload.aud !== expectedAudience) {
                lastError = `Google ID Token audience mismatch (expected ${expectedAudience}, got ${payload.aud})`;
                this.logger.error(lastError);
              } else if (payload.email && payload.sub) {
                email = payload.email;
                name = payload.name;
                picture = payload.picture;
                sub = payload.sub;
                this.logger.log(`Google ID Token successfully validated via local claims verification for ${email}`);
              } else {
                lastError = `Missing email or sub in token payload`;
              }
            }
          } catch (jwtErr: any) {
            lastError = `Local JWT payload parsing exception: ${jwtErr.message}`;
            this.logger.error(lastError);
          }
        }
      } else {
        // 2. OAuth 2.0 Access Token Verification via Google UserInfo REST API
        verificationMethod = 'Google UserInfo REST API (https://www.googleapis.com/oauth2/v3/userinfo)';
        try {
          const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = (await res.json()) as { email?: string; name?: string; picture?: string; sub?: string };
            if (data.email) {
              email = data.email;
              name = data.name;
              picture = data.picture;
              sub = data.sub;
            }
          } else {
            const errText = await res.text();
            lastError = `HTTP ${res.status}: ${errText}`;
            this.logger.error(`Google UserInfo API returned error: ${lastError}`);
          }
        } catch (fetchErr: any) {
          lastError = fetchErr?.message || String(fetchErr);
          this.logger.warn(`global fetch failed for UserInfo API (${lastError}), attempting https.get fallback...`);

          // Native Node.js https.get fallback
          try {
            const httpsData = await new Promise<{ email?: string; name?: string; picture?: string; sub?: string }>((resolve, reject) => {
              const req = https.get(
                'https://www.googleapis.com/oauth2/v3/userinfo',
                { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Node.js' } },
                (resp) => {
                  let body = '';
                  resp.on('data', (chunk) => (body += chunk));
                  resp.on('end', () => {
                    if (resp.statusCode === 200) {
                      try {
                        resolve(JSON.parse(body));
                      } catch (e) {
                        reject(e);
                      }
                    } else {
                      reject(new Error(`HTTP ${resp.statusCode}: ${body}`));
                    }
                  });
                },
              );
              req.on('error', reject);
              req.setTimeout(5000, () => {
                req.destroy();
                reject(new Error('https.get timeout after 5000ms'));
              });
            });

            if (httpsData.email) {
              email = httpsData.email;
              name = httpsData.name;
              picture = httpsData.picture;
              sub = httpsData.sub;
              this.logger.log(`Google UserInfo validated via https.get fallback for ${email}`);
            }
          } catch (httpsErr: any) {
            lastError = httpsErr?.message || String(httpsErr);
            this.logger.error(`https.get UserInfo fallback failed: ${lastError}`);
          }
        }
      }

      if (!email || !sub) {
        this.logger.error(
          `Google Auth Failed — Verification Method: [${verificationMethod}], Type: [${tokenType}], Prefix: [${first20Chars}], Last Error: [${lastError || 'None'}]`,
        );
        throw new BadRequestException(
          `Google token verification failed (${tokenType}): ${lastError || 'Invalid or expired token'}`,
        );
      }

      let user = await this.usersService.findByEmail(email);
      let isNewUser = false;

      if (!user) {
        user = await this.usersService.create({
          email,
          name: name || email.split('@')[0],
          googleId: sub,
          avatarUrl: picture,
          emailVerified: true,
        });
        isNewUser = true;
      } else {
        if (!user.googleId) {
          await this.usersService.linkGoogleAccount(user.id, sub);
        }

        // Google profile-image URLs can change or expire. Refresh only an
        // existing Google avatar (or a missing avatar) so a custom upload is
        // never overwritten during sign-in.
        const isGoogleAvatar = (url: string | null) =>
          !!url && /(^https:\/\/.*\.googleusercontent\.com\/|^https:\/\/.*\.google\.com\/)/i.test(url);
        if (picture && (!user.avatarUrl || isGoogleAvatar(user.avatarUrl)) && user.avatarUrl !== picture) {
          user = await this.usersService.update(user.id, { avatarUrl: picture });
        }
      }

      const tokens = await this.generateTokens(user.id, user.email, user.role);
      await this.usersService.updateLastLogin(user.id);

      if (isNewUser) {
        try {
          await this.emailService.sendWelcomeEmail(user.email, user.name || user.email);
        } catch (emailErr: any) {
          this.logger.warn(`Failed to send welcome email (${emailErr.message}), continuing login...`);
        }
      }

      const subscription = await this.getSubscriptionDto(user.id, user.email);

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl || undefined,
          role: user.role,
          profileCompleted: user.profileCompleted ?? false,
        },
        tokens,
        subscription,
      };
    } catch (error: any) {
      this.logger.error(`Google auth exception details: ${error?.message || error}`);
      if (error?.stack) {
        this.logger.error(error.stack);
      }
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) {
        throw error;
      }
      throw new BadRequestException(`Google authentication error: ${error?.message || 'Internal failure'}`);
    }
  }

  async appleAuth(dto: OAuthDto): Promise<{
    user: { id: string; email: string };
    tokens: TokenPair;
    subscription: SubscriptionDto;
  }> {
    try {
      // Decode the identity token header to get the key ID
      const decoded = jwt.decode(dto.idToken, { complete: true });
      if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
        throw new BadRequestException('Invalid Apple token');
      }

      // Get the signing key from Apple's JWKS
      const key = await this.appleJwksClient.getSigningKey(decoded.header.kid);
      const publicKey = key.getPublicKey();

      // Verify the token
      const payload = jwt.verify(dto.idToken, publicKey, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: this.appleClientId,
      }) as jwt.JwtPayload;

      if (!payload.email) {
        throw new BadRequestException('Email not provided by Apple');
      }

      // Find or create user
      let user = await this.usersService.findByEmail(payload.email);

      if (!user) {
        // Apple only provides name on first auth, use it if available
        const name = dto.userData?.name || payload.email.split('@')[0];
        user = await this.usersService.create({
          email: payload.email,
          name,
          appleId: payload.sub,
          emailVerified: payload.email_verified === 'true' || payload.email_verified === true,
        });

        // Send welcome email
        await this.emailService.sendWelcomeEmail(user.email, user.name || user.email);
      } else if (!user.appleId) {
        // Link Apple account to existing user
        await this.usersService.linkAppleAccount(user.id, payload.sub!);
      }

      const tokens = await this.generateTokens(user.id, user.email, user.role);
      await this.usersService.updateLastLogin(user.id);

      // Get subscription details
      const subscription = await this.getSubscriptionDto(user.id, user.email);

      return {
        user: { id: user.id, email: user.email },
        tokens,
        subscription,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error('Apple auth failed', error);
      throw new UnauthorizedException('Apple authentication failed');
    }
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      // Don't reveal if email exists
      return;
    }

    const resetToken = uuidv4();
    const resetExpiry = 60 * 60; // 1 hour

    await this.redisService.set(`password-reset:${resetToken}`, user.id, resetExpiry);

    // Send password reset email
    const emailSent = await this.emailService.sendPasswordResetEmail(email, resetToken);
    if (emailSent) {
      this.logger.log(`Password reset email sent to ${email}`);
    } else {
      this.logger.warn(`Failed to send password reset email to ${email}`);
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await this.redisService.get(`password-reset:${token}`);
    if (!userId) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.usersService.updatePassword(userId, hashedPassword);
    await this.redisService.del(`password-reset:${token}`);

    this.logger.log(`Password reset completed for user ${userId}`);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.password) {
      throw new BadRequestException('Cannot change password for this account');
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid current password');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.usersService.updatePassword(userId, hashedPassword);
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.redisService.get(`email-verify:${token}`);
    if (!userId) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    await this.usersService.verifyEmail(userId);
    await this.redisService.del(`email-verify:${token}`);
  }

  async resendVerificationEmail(userId: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (user.emailVerified) {
      throw new BadRequestException('Email already verified');
    }

    const verifyToken = uuidv4();
    const verifyExpiry = 24 * 60 * 60; // 24 hours

    await this.redisService.set(`email-verify:${verifyToken}`, user.id, verifyExpiry);

    // Send verification email
    const emailSent = await this.emailService.sendVerificationEmail(user.email, verifyToken);
    if (emailSent) {
      this.logger.log(`Verification email sent to ${user.email}`);
    } else {
      this.logger.warn(`Failed to send verification email to ${user.email}`);
    }
  }

  private async generateTokens(userId: string, email: string, role: string): Promise<TokenPair> {
    const payload: JwtPayload = { sub: userId, email, role };
    const accessSecret =
      this.configService.get<string>('JWT_ACCESS_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      'eduverse_jwt_secret_key_32chars_min';
    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      'eduverse_refresh_secret_key_32chars_min';

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: accessSecret,
        expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRATION', '7d'),
      }),
      this.jwtService.signAsync(payload, {
        secret: refreshSecret,
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRATION', '30d'),
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: 604800, // 7 days in seconds
    };
  }

  private async getSubscriptionDto(userId: string, email: string): Promise<SubscriptionDto> {
    const subscription = await this.subscriptionService.getOrCreateSubscription(userId, email);

    return {
      plan: (subscription.plan === 'pro' || subscription.plan === 'enterprise'
        ? 'yearly'
        : subscription.plan) as 'free' | 'monthly' | 'yearly',
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart || undefined,
      currentPeriodEnd: subscription.currentPeriodEnd || undefined,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
    };
  }

  private async blacklistToken(token: string): Promise<void> {
    try {
      const payload = this.jwtService.decode(token) as { exp?: number };
      const ttl = payload?.exp ? payload.exp - Math.floor(Date.now() / 1000) : 60 * 60 * 24 * 7;
      if (ttl > 0) {
        await this.redisService.set(`blacklist:${token}`, '1', ttl);
      }
    } catch {
      // Token invalid, no need to blacklist
    }
  }
}
