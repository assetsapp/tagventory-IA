import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const SECRET = process.env.JWT_SECRET || 'change_this_dev_secret';
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';

export function signJwt(payload, options = {}) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN, ...options });
}

export function verifyJwt(token) {
  return jwt.verify(token, SECRET);
}

