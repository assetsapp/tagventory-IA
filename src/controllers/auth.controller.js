import bcrypt from 'bcryptjs';
import { getDb } from '../config/mongo.js';
import { signJwt } from '../config/jwt.js';

/**
 * POST /auth/login
 *
 * Login sencillo con email + password contra la colección "users"
 * reutilizando los usuarios de tu proyecto Baas (mismo Mongo/DB_NAME).
 */
export async function postLogin(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email y password son requeridos',
      });
    }

    const db = getDb();
    if (!db) throw new Error('MongoDB no conectado');

    // En Baas la colección se llama "user" (no "users")
    const user = await db.collection('user').findOne({ email });
    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'Credenciales inválidas',
      });
    }

    const isValid = await bcrypt.compare(password, user.password || '');
    if (!isValid) {
      return res.status(401).json({
        status: 'error',
        message: 'Credenciales inválidas',
      });
    }

    const token = signJwt({
      id: user._id,
      email: user.email,
      name: user.name,
    });

    return res.json({
      status: 'ok',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error al iniciar sesión',
    });
  }
}

