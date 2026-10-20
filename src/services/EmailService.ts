/** Envoi d'emails par SendGrid (API v3). Sans clé configurée, rien n'est envoyé. */
export const EmailService = {
  configure: () => !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM),

  async envoyer(to: string, sujet: string, texte: string, html: string) {
    if (!this.configure()) return false;
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: process.env.SENDGRID_FROM, name: process.env.SENDGRID_FROM_NAME || 'me' },
          subject: sujet,
          content: [
            { type: 'text/plain', value: texte },
            { type: 'text/html', value: html },
          ],
        }),
      });
      if (!res.ok) console.error('SendGrid', res.status, (await res.text()).slice(0, 300));
      return res.ok;
    } catch (e) {
      console.error('SendGrid injoignable', e);
      return false;
    }
  },
};
