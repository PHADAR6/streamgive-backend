import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '../db.js';

const CONTACT_EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function sendContactVerification(application: {
  id: string;
  name: string;
  contactEmail: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_EMAIL_FROM;
  const publicApiUrl = process.env.API_PUBLIC_URL;
  if (!apiKey || !from || !publicApiUrl) {
    console.warn('contact email verification is not configured');
    return false;
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(publicApiUrl);
  } catch {
    console.error('API_PUBLIC_URL must be an absolute URL');
    return false;
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
    console.error('API_PUBLIC_URL must use HTTPS');
    return false;
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CONTACT_EMAIL_TOKEN_TTL_MS);
  try {
    await prisma.ngoApplicationContactChallenge.upsert({
      where: { applicationId: application.id },
      create: {
        applicationId: application.id,
        tokenHash: hashToken(token),
        expiresAt,
      },
      update: { tokenHash: hashToken(token), expiresAt },
    });
  } catch {
    console.error('failed to store contact verification challenge');
    return false;
  }

  const verificationUrl = new URL('/v1/ngo-applications/verify-contact-email', baseUrl);
  verificationUrl.searchParams.set('token', token);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [application.contactEmail],
        subject: 'Verify your StreamGive NGO contact email',
        html: `<p>Hello ${escapeHtml(application.name)},</p><p><a href="${verificationUrl.toString()}">Verify this contact email</a>. This link expires in 24 hours.</p>`,
      }),
    });
    if (!response.ok) {
      console.error(`contact verification email was rejected (status ${response.status})`);
      return false;
    }
    return true;
  } catch {
    console.error('failed to send contact verification email');
    return false;
  }
}

export async function verifyContactToken(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  return prisma.$transaction(async (tx) => {
    const challenge = await tx.ngoApplicationContactChallenge.findUnique({
      where: { tokenHash },
    });
    if (!challenge || challenge.expiresAt.getTime() <= Date.now()) {
      if (challenge) {
        await tx.ngoApplicationContactChallenge.deleteMany({ where: { tokenHash } });
      }
      return false;
    }

    const consumed = await tx.ngoApplicationContactChallenge.deleteMany({ where: { tokenHash } });
    if (consumed.count !== 1) return false;

    await tx.ngoApplication.update({
      where: { id: challenge.applicationId },
      data: { emailVerifiedAt: new Date() },
    });
    return true;
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}
