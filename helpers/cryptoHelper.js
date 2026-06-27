const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
// Generates a secure 32-byte key from your environment secret
const SECRET_KEY = crypto
  .createHash('sha256')
  .update(process.env.PIN_SECRET_KEY || 'default-fallback-secret-key-32-chars-long')
  .digest();

const IV_LENGTH = 16; // Initialization Vector length for AES-256

// 1. Encrypt plain-text "1234" into secure gibberish
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  // Return IV joined with encrypted text so we can decrypt it later
  return iv.toString('hex') + ':' + encrypted;
}

// 2. Decrypt secure gibberish back into plain-text "1234"
function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // If decryption fails (e.g. if database value is still an old bcrypt hash), return null
    return null;
  }
}

module.exports = { encrypt, decrypt };