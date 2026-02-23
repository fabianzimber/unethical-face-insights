"use client";

import { useState } from 'react';
import styles from './InviteGenerator.module.css';

export function InviteGenerator() {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generateCode = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    
    try {
      const res = await fetch('/api/auth/invite/generate', { method: 'POST' });
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'FAILED TO GENERATE');
      
      setCode(data.code);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>ADMIN CONSOLE // INVITE GENERATOR</span>
      </div>
      
      <div className={styles.content}>
        <p className={styles.desc}>
          GENERATE SINGLE-USE AUTHORIZATION CIPHERS. CODES EXPIRE 20 MINUTES AFTER CREATION.
        </p>

        {error && <div className={styles.error}>ERR: {error}</div>}

        <div className={styles.actionArea}>
          <button 
            onClick={generateCode} 
            disabled={loading}
            className={styles.generateBtn}
          >
            {loading ? 'GENERATING...' : '[ FORGE_NEW_CIPHER ]'}
          </button>

          {code && (
            <div className={styles.resultBox} onClick={copyCode}>
              <span className={styles.codeText}>{code}</span>
              <span className={styles.copyStatus}>
                {copied ? 'COPIED TO CLIPBOARD' : 'CLICK TO COPY'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
