import { NextResponse } from 'next/server';
import { db, verifyAuthJWT, Invite } from '@/lib/auth';
import { cookies } from 'next/headers';
import { randomInt } from 'crypto';

// Abstract, philosophical, dystopian words in leetspeak
const WORDS = [
  '0BL1V10N', 'N1H1L1SM', 'P4N0PT1C', 'V01D', 'SYNTH3T1C',
  'P4R4D1GM', '3NR0PY', 'S1MUL4CR4', 'S0L1PS1SM', '4N0M4LY',
  'M4TR1X', 'CYB3RN3T1C', 'DYSCHRON14', 'C4T4CLYSM', 'N3UROM4NC3R',
  '4UT0M4T4', 'H0L0GR4M', '4P0C4LYP5E', '3X1ST3NC3', 'PH4NT0M'
];

const MAX_ACTIVE_INVITES = 10;
const TWENTY_MINUTES_MS = 20 * 60 * 1000;

export async function POST(req: Request) {
  try {
    // Only owners can generate invites
    const cookieStore = await cookies();
    const token = cookieStore.get('auth_token')?.value;
    const auth = await verifyAuthJWT(token);

    if (!auth || auth.role !== 'owner') {
      return NextResponse.json({ error: 'Unauthorized. Owner override required.' }, { status: 403 });
    }

    // Use crypto.randomInt for better entropy
    const word1 = WORDS[randomInt(WORDS.length)];
    let word2 = WORDS[randomInt(WORDS.length)];
    while (word1 === word2) word2 = WORDS[randomInt(WORDS.length)];
    const num = randomInt(1000, 9999); // 4-digit number for more entropy

    const newCode = `${word1}-${word2}-${num}`;

    const newInvite: Invite = {
      code: newCode,
      createdAt: Date.now(),
    };

    await db.update((data) => {
      const now = Date.now();
      // Prune expired invites
      data.activeInvites = data.activeInvites.filter(
        invite => now - invite.createdAt < TWENTY_MINUTES_MS
      );
      // Cap active invites to prevent unbounded growth
      if (data.activeInvites.length >= MAX_ACTIVE_INVITES) {
        data.activeInvites = data.activeInvites.slice(-MAX_ACTIVE_INVITES + 1);
      }
      data.activeInvites.push(newInvite);
    });

    return NextResponse.json({ code: newCode });
  } catch (error) {
    console.error('Error generating invite:', error);
    return NextResponse.json({ error: 'System failure' }, { status: 500 });
  }
}
