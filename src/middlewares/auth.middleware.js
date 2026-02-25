import { verifyJwt } from '../config/jwt.js';

export function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    if (!token) {
      return res.status(401).json({
        status: 'error',
        message: 'Token no proporcionado',
      });
    }

    const payload = verifyJwt(token);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({
      status: 'error',
      message: 'Token inválido o expirado',
    });
  }
}

