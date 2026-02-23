import fs from 'fs';
import path from 'path';
import { SignJWT, jwtVerify } from 'jose';

const DB_PATH = path.join(process.cwd(), 'data', 'auth.json');
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'a-very-secure-secret-that-should-be-in-env-brutalist'
);

export type AuthRole = 'owner' | 'guest';

export interface OwnerCredential {
  id: string;
  publicKey: Uint8Array;
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

const defaultDB: AuthDB = {
  ownerCredential: null,
  activeInvites: [], // Empty default state, fully secure
  currentChallenge: null,
};

function readDB(): AuthDB {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const fresh: AuthDB = { ...defaultDB, activeInvites: [] };
      writeDB(fresh);
      return fresh;
    }
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    
    // Convert base64 publicKey back to Uint8Array for WebAuthn
    if (parsed.ownerCredential && parsed.ownerCredential.publicKey) {
      parsed.ownerCredential.publicKey = new Uint8Array(
        Buffer.from(parsed.ownerCredential.publicKey, 'base64')
      );
    }
    
    return { ...defaultDB, ...parsed };
  } catch (error) {
    console.error('Error reading auth.json:', error);
    return { ...defaultDB, activeInvites: [] };
  }
}

function writeDB(db: AuthDB) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Convert Uint8Array to base64 for JSON serialization
    const serializedDB = { ...db };
    if (serializedDB.ownerCredential && serializedDB.ownerCredential.publicKey) {
      serializedDB.ownerCredential = {
        ...serializedDB.ownerCredential,
        publicKey: Buffer.from(serializedDB.ownerCredential.publicKey).toString('base64') as any
      };
    }

    fs.writeFileSync(DB_PATH, JSON.stringify(serializedDB, null, 2));
  } catch (error) {
    console.error('Error writing auth.json:', error);
  }
}

// Simple in-process lock to prevent concurrent read-modify-write corruption
let dbLock: Promise<void> = Promise.resolve();

export const db = {
  read: readDB,
  write: writeDB,
  /** Run an atomic read-modify-write operation with a lock */
  async update(fn: (data: AuthDB) => AuthDB | void): Promise<AuthDB> {
    let release: () => void;
    const prev = dbLock;
    dbLock = new Promise((resolve) => { release = resolve; });
    await prev;
    try {
      const data = readDB();
      const result = fn(data);
      const updated = result ?? data;
      writeDB(updated);
      return updated;
    } finally {
      release!();
    }
  },
};

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
