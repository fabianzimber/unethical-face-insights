import { Redis } from '@upstash/redis';
import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'a-very-secure-secret-that-should-be-in-env-brutalist'
);

export type AuthRole = 'owner' | 'guest';

export interface OwnerCredential {
  id: string;
  publicKey: string; // base64 encoded for Redis storage
  counter: number;
  transports?: string[];
}

export interface Invite {
  code: string;
  createdAt: number;
}

export interface AuthDB {
  ownerCredential: OwnerCredential | null;
  activeInvites: Invite[];
  currentChallenge: string | null;
}

const REDIS_KEY = 'auth:db';

const defaultDB: AuthDB = {
  ownerCredential: null,
  activeInvites: [],
  currentChallenge: null,
};

function getRedis(): Redis {
  return Redis.fromEnv();
}

async function readDB(): Promise<AuthDB> {
  try {
    const data = await getRedis().get<AuthDB>(REDIS_KEY);
    if (!data) return { ...defaultDB, activeInvites: [] };
    return { ...defaultDB, ...data };
  } catch (error) {
    console.error('Error reading from Redis:', error);
    return { ...defaultDB, activeInvites: [] };
  }
}

async function writeDB(data: AuthDB): Promise<void> {
  try {
    await getRedis().set(REDIS_KEY, data);
  } catch (error) {
    console.error('Error writing to Redis:', error);
  }
}

export const db = {
  read: readDB,
  write: writeDB,
  /** Run an atomic read-modify-write operation */
  async update(fn: (data: AuthDB) => AuthDB | void): Promise<AuthDB> {
    const data = await readDB();
    const result = fn(data);
    const updated = result ?? data;
    await writeDB(updated);
    return updated;
  },
};

/** Convert a Uint8Array publicKey to base64 for storage */
export function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64');
}

/** Convert a base64-stored publicKey back to Uint8Array for WebAuthn */
export function publicKeyFromBase64(key: string): Uint8Array {
  return new Uint8Array(Buffer.from(key, 'base64'));
}

export async function signAuthJWT(role: AuthRole): Promise<string> {
  const expiry = role === 'guest' ? '20m' : '30d';
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(JWT_SECRET);
}

export async function verifyAuthJWT(token: string | undefined): Promise<{ role: AuthRole } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.role === 'owner' || payload.role === 'guest') {
      return { role: payload.role as AuthRole };
    }
    return null;
  } catch (error) {
    return null;
  }
}
