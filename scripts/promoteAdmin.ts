// Nomme un compte admin : npm run promote:admin -- email@exemple.com
import '../src/loadEnv.js';

import { prisma } from '../src/utils/prisma.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage : npm run promote:admin -- email@exemple.com');
  process.exit(1);
}
const user = await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } }).catch(() => null);
console.log(user ? `${user.email} est maintenant admin.` : `Aucun compte pour ${email}.`);
await prisma.$disconnect();
