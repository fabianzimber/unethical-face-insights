"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import styles from './login.module.css';

export default function LoginPage() {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<string>('awaiting authorization...');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setStatus('verifying cipher...');

    try {
      const res = await fetch('/api/auth/invite/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'ACCESS_DENIED');
      }

      setStatus('access granted. initializing protocols...');
      setTimeout(() => router.push('/'), 800);
    } catch (err: any) {
      setError(`ERR_UNAUTHORIZED: ${err.message}`);
      setStatus('awaiting authorization...');
    } finally {
      setLoading(false);
    }
  };

  const handleBiometricAuth = async () => {
    setLoading(true);
    setError(null);
    setStatus('communicating with sensor...');

    try {
      // 1. Get challenge
      const challengeRes = await fetch('/api/auth/webauthn/challenge', { method: 'POST' });
      if (!challengeRes.ok) {
        const errData = await challengeRes.json().catch(() => ({}));
        throw new Error(errData.error || 'SYSTEM_FAILURE: CHALLENGE_REJECTED');
      }
      const options = await challengeRes.json();

      if (!options) throw new Error('SYSTEM_FAILURE: NO_CHALLENGE');

      let verificationRes;

      if (options.user) {
        // First time - Registration
        setStatus('initializing biometric registration...');
        const attResp = await startRegistration({ optionsJSON: options });
        setStatus('registering template...');
        verificationRes = await fetch('/api/auth/webauthn/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attResp),
        });
      } else {
        // Login - Authentication
        setStatus('awaiting fingertip sensor...');
        const asseResp = await startAuthentication({ optionsJSON: options });
        setStatus('verifying signature...');
        verificationRes = await fetch('/api/auth/webauthn/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(asseResp),
        });
      }

      const verificationData = await verificationRes.json();

      if (verificationData.success) {
        setStatus('override accepted. welcome owner.');
        setTimeout(() => router.push('/'), 800);
      } else {
        throw new Error(verificationData.error || 'BIOMETRIC_REJECTED');
      }
    } catch (err: any) {
      setError(`SENSOR_ERR: ${err.message}`);
      setStatus('awaiting authorization...');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.loginContainer}>
      <div className={styles.terminal}>
        <div className={styles.header}>
          <div className={styles.title}>unethical_face_insights</div>
          <div className={styles.status}>status: {status}</div>
        </div>

        {error && (
          <div className={styles.errorBox}>
            <div className={styles.errorText}>{error}</div>
            <div className={styles.errorBlink}>█</div>
          </div>
        )}

        <form onSubmit={handleInviteSubmit} className={styles.inviteForm}>
          <label className={styles.label}>enter authorization cipher:</label>
          <div className={styles.inputWrapper}>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className={styles.input}
              placeholder="v01d-m4tr1x-99"
              spellCheck="false"
              autoComplete="off"
              disabled={loading}
              maxLength={30}
            />
            <button type="submit" disabled={loading || !code} className={styles.submitBtn}>
              inject cipher
            </button>
          </div>
        </form>

        <div className={styles.divider}>
          <div className={styles.line}></div>
          <span>OR</span>
          <div className={styles.line}></div>
        </div>

        <button
          onClick={handleBiometricAuth}
          disabled={loading}
          className={styles.ownerBtn}
        >
          <div className={styles.fingerprint}>
            <div className={styles.fingerprintInner}></div>
          </div>
          <span className={styles.btnText}>initiate biometric override</span>
        </button>
      </div>
    </main>
  );
}
