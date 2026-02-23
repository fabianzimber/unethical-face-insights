import { NextResponse } from 'next/server';
import { db, signAuthJWT } from '@/lib/auth';
import { cookies } from 'next/headers';

const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 10;
const RATE_WINDOW_MS = 60 * 1000; // 1 minute

// Simple in-memory rate limiter (per-process)
const attempts = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const ipAttempts = (attempts.get(ip) || []).filter(t => t > windowStart);
  attempts.set(ip, ipAttempts);
  if (ipAttempts.length >= MAX_ATTEMPTS_PER_WINDOW) return true;
  ipAttempts.push(now);
  return false;
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (isRateLimited(ip)) {
      return NextResponse.json({ error: 'R4T3_L1M1T: T00_M4NY_4TT3MPT5' }, { status: 429 });
    }

    const { code } = await req.json();

    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'M4LF0RMED_S1GN4TUR3' }, { status: 400 });
    }

    const normalizedCode = code.toUpperCase().trim();
    const now = Date.now();

    // Use atomic update to prevent TOCTOU
    let found = false;
    await db.update((data) => {
      // Clean up expired invites
      data.activeInvites = data.activeInvites.filter(
        invite => now - invite.createdAt < TWENTY_MINUTES_MS
      );

      const inviteIndex = data.activeInvites.findIndex(
        invite => invite.code === normalizedCode
      );

      if (inviteIndex !== -1) {
        found = true;
        data.activeInvites.splice(inviteIndex, 1);
      }
    });

    if (!found) {
      return NextResponse.json({ error: 'UN4UTH0R1Z3D: C0D3_R3JECTED' }, { status: 401 });
    }

    // Issue guest token (invite already consumed atomically above)
    const token = await signAuthJWT('guest');
    const cookieStore = await cookies();
    cookieStore.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 20 * 60, // 20 minutes session for the guest
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error verifying invite:', error);
    return NextResponse.json({ error: 'SYSTEM_3RR0R' }, { status: 500 });
  }
}
