import { NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { db, signAuthJWT, publicKeyToBase64 } from '@/lib/auth';
import { cookies } from 'next/headers';
import { rpID, expectedOrigin } from '@/lib/webauthn-config';

export async function POST(req: Request) {
  try {
    const data = await db.read();
    const body = await req.json();

    if (!data.currentChallenge) {
      return NextResponse.json({ error: 'No active challenge' }, { status: 400 });
    }

    if (data.ownerCredential) {
      return NextResponse.json({ error: 'Owner already registered' }, { status: 400 });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: data.currentChallenge,
        expectedOrigin,
        expectedRPID: rpID,
      });
    } catch (error) {
      console.error(error);
      data.currentChallenge = null;
      await db.write(data);
      return NextResponse.json({ error: 'Verification failed' }, { status: 400 });
    }

    const { verified, registrationInfo } = verification;

    if (verified && registrationInfo) {
      const { credential } = registrationInfo;

      // Ensure that we clear the challenge
      data.currentChallenge = null;

      // Save the credential (publicKey stored as base64 string for Redis)
      data.ownerCredential = {
        id: credential.id,
        publicKey: publicKeyToBase64(credential.publicKey),
        counter: registrationInfo.credential.counter ?? 0,
        transports: body.response.transports,
      };

      await db.write(data);

      // Give them a session immediately upon registration
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
    console.error('Error in registration route:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
