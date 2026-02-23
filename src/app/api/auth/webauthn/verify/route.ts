import { NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { db, signAuthJWT } from '@/lib/auth';
import { cookies } from 'next/headers';
import { rpID, expectedOrigin } from '@/lib/webauthn-config';

export async function POST(req: Request) {
  try {
    const data = db.read();
    const body = await req.json();

    if (!data.currentChallenge) {
      return NextResponse.json({ error: 'No active challenge' }, { status: 400 });
    }

    if (!data.ownerCredential) {
      return NextResponse.json({ error: 'No owner registered' }, { status: 400 });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: data.currentChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: data.ownerCredential.id,
          publicKey: new Uint8Array(data.ownerCredential.publicKey) as any,
          counter: data.ownerCredential.counter,
          transports: data.ownerCredential.transports as any,
        },
      });
    } catch (error) {
      console.error(error);
      data.currentChallenge = null;
      db.write(data);
      return NextResponse.json({ error: 'Verification failed' }, { status: 400 });
    }

    const { verified, authenticationInfo } = verification;

    if (verified && authenticationInfo) {
      // Update the counter
      data.ownerCredential.counter = authenticationInfo.newCounter;
      data.currentChallenge = null;
      db.write(data);

      // Create session
      const token = await signAuthJWT('owner');
      const cookieStore = await cookies();
      cookieStore.set('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60, // 30 days
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Not verified' }, { status: 400 });
  } catch (error) {
    console.error('Error in verification route:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
