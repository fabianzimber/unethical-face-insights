import { NextResponse } from 'next/server';
import { generateRegistrationOptions, generateAuthenticationOptions } from '@simplewebauthn/server';
import { db } from '@/lib/auth';
import { rpID, rpName } from '@/lib/webauthn-config';

export async function POST(req: Request) {
  try {
    const data = await db.read();
    let options;

    if (!data.ownerCredential) {
      // First time setup - Generate Registration Options
      options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: new Uint8Array(Buffer.from('owner-id-123')), // Constant ID for the single owner
        userName: 'Owner',
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
          authenticatorAttachment: 'platform', // Enforce TouchID/Windows Hello
        },
      });
    } else {
      // Login - Generate Authentication Options
      options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [{
          id: data.ownerCredential.id,
          transports: data.ownerCredential.transports as any,
        }],
        userVerification: 'required',
      });
    }

    // Save challenge to DB
    data.currentChallenge = options.challenge;
    await db.write(data);

    return NextResponse.json(options);
  } catch (error) {
    console.error('Error generating challenge:', error);
    return NextResponse.json({ error: 'Failed to generate challenge' }, { status: 500 });
  }
}
