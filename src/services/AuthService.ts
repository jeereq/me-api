import bcrypt from 'bcryptjs';

import { HttpError } from '../utils/http.js';
import { generateToken } from '../utils/jwt.js';
import { prisma } from '../utils/prisma.js';

const publicUser = (u: { id: string; email: string; nom: string; role: 'ADMIN' | 'UTILISATEUR' }) => ({ id: u.id, email: u.email, nom: u.nom, role: u.role });

export const AuthService = {
  async register(email: string, password: string, nom = '') {
    const passwordHash = await bcrypt.hash(password, 12);
    // Transaction sérialisable : deux inscriptions simultanées ne peuvent pas créer deux « premiers » admins.
    const user = await prisma.$transaction(
      async (tx) => {
        const count = await tx.user.count();
        if (count > 0 && process.env.SIGNUP_OPEN === 'false') throw new HttpError(403, "Les inscriptions sont fermées. Demande à l'admin.");
        if (await tx.user.findUnique({ where: { email } })) throw new HttpError(409, 'Un compte existe déjà avec cet email.');
        return tx.user.create({ data: { email, passwordHash, nom, role: count === 0 && !process.env.ADMIN_EMAIL ? 'ADMIN' : 'UTILISATEUR' } });
      },
      { isolationLevel: 'Serializable' },
    );
    return { token: generateToken({ userId: user.id }), user: publicUser(user) };
  },

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    // Même message dans les deux cas pour ne pas révéler quels emails ont un compte.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Email ou mot de passe incorrect.');
    return { token: generateToken({ userId: user.id }), user: publicUser(user) };
  },

  async updateMe(userId: string, input: { nom?: string; fuseau?: string; motDePasseActuel?: string; nouveauMotDePasse?: string }) {
    const data: { nom?: string; fuseau?: string; passwordHash?: string } = {};
    if (input.nom !== undefined) data.nom = input.nom;
    if (input.fuseau !== undefined) data.fuseau = input.fuseau;
    if (input.nouveauMotDePasse) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (!input.motDePasseActuel || !(await bcrypt.compare(input.motDePasseActuel, user.passwordHash))) throw new HttpError(400, 'Mot de passe actuel incorrect.');
      data.passwordHash = await bcrypt.hash(input.nouveauMotDePasse, 12);
    }
    return publicUser(await prisma.user.update({ where: { id: userId }, data }));
  },
};
