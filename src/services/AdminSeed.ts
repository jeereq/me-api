import bcrypt from 'bcryptjs';

import { prisma } from '../utils/prisma.js';

/**
 * Compte admin principal défini par ADMIN_EMAIL et ADMIN_PASSWORD : créé au démarrage s'il n'existe pas,
 * toujours admin, et son mot de passe suit la variable (la changer puis redémarrer remplace l'ancien).
 */
export async function assurerAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password) throw new Error('ADMIN_EMAIL et ADMIN_PASSWORD doivent être définis ensemble.');
  if (password.length < 8) throw new Error('ADMIN_PASSWORD doit faire au moins 8 caractères.');

  const existant = await prisma.user.findUnique({ where: { email } });
  if (!existant) {
    await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 12), nom: process.env.ADMIN_NOM || '', role: 'ADMIN' } });
    console.log(`Compte admin créé : ${email}`);
    return;
  }
  const data: { role?: 'ADMIN'; passwordHash?: string } = {};
  if (existant.role !== 'ADMIN') data.role = 'ADMIN';
  if (!(await bcrypt.compare(password, existant.passwordHash))) data.passwordHash = await bcrypt.hash(password, 12);
  if (Object.keys(data).length) {
    await prisma.user.update({ where: { id: existant.id }, data });
    console.log(`Compte admin mis à jour : ${email}`);
  }
}
