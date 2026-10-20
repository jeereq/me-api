import jwt from 'jsonwebtoken';

interface JWTPayload {
  userId: string;
}

const secret = () => process.env.JWT_SECRET as string;

export const generateToken = (payload: JWTPayload): string => jwt.sign(payload, secret(), { expiresIn: '30d' });

export const verifyToken = (token: string) => jwt.verify(token, secret()) as JWTPayload & { iat?: number };
