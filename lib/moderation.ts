import { createHash } from 'node:crypto';

/** Public blocking reference only; never expose the authentication UUID/email. */
export function feedbackAuthorRef(userId: string | null | undefined): string | null {
  return userId ? createHash('sha256').update(`feedback-author:${userId}`).digest('hex').slice(0, 32) : null;
}

/**
 * A small first-pass text filter, not a guarantee of content safety. Normal
 * negative food opinions are allowed. Reports still require human review.
 */
export function isObjectionableText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase();
  return /\b(?:fuck(?:ing|er|ers)?|cunt|faggot|nigger|nigga|porn(?:ography)?|kys)\b/u.test(text)
    || /\b(?:kill yourself|i (?:will|am going to) kill you|i hope you die|rape you)\b/u.test(text)
    || /https?:\/\/|www\.|\b(?:t\.me|bit\.ly)\//u.test(text);
}
