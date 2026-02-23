import { NextResponse } from 'next/server';
import { verifyAuthJWT } from '@/lib/auth';
import { cookies } from 'next/headers';

export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('auth_token')?.value;
    const auth = await verifyAuthJWT(token);

    if (!auth) {
      return NextResponse.json({ role: null }, { status: 401 });
    }

    return NextResponse.json({ role: auth.role });
  } catch (error) {
    return NextResponse.json({ role: null }, { status: 500 });
  }
}
