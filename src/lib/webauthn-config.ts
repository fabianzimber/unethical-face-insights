const rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
const rpName = 'Unethical Face Insights';

const isProduction = process.env.NODE_ENV === 'production';
const expectedOrigin = process.env.WEBAUTHN_ORIGIN
  || (isProduction ? `https://${rpID}` : `http://${rpID}:3000`);

export { rpID, rpName, expectedOrigin };
