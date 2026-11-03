import jwt from 'jsonwebtoken';

interface JWTPayload {
  userId: string;
}

const secret = () => process.env.JWT_SECRET as string;

export const generateToken = (payload: JWTPayload): string => jwt.sign(payload, secret(), { expiresIn: '30d' });

/** Un jeton de session seulement : les jetons à usage unique (`typ` : retour OAuth, lien de pièce jointe) voyagent dans des adresses et n'ouvrent pas de session. */
export const verifyToken = (token: string) => {
  const p = jwt.verify(token, secret()) as JWTPayload & { iat?: number; typ?: string };
  if (p.typ) throw new Error('Ce jeton ne sert pas à ouvrir une session.');
  return p;
};
