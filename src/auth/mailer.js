// Outbound email. SMTP_URL set => real delivery via nodemailer; otherwise an in-memory outbox (dev/tests) and a log line.
export async function createMailer({ smtpUrl, from, log }) {
  if (!smtpUrl) {
    const outbox = [];
    return {
      outbox, kind: 'memory',
      async send(msg) { outbox.push({ ...msg, at: Date.now() }); log?.info('email (dev outbox, not delivered)', { to: msg.to, subject: msg.subject }); },
    };
  }
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    kind: 'smtp',
    async send(msg) { await transport.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text }); },
    async verify() { await transport.verify(); },
    close() { transport.close(); },
  };
}

export const templates = {
  verify: (link) => ({ subject: 'Verify your MobiAd email', text: `Welcome to MobiAd.\n\nConfirm your email address to start creating campaigns and apps:\n\n${link}\n\nThis link expires in 24 hours. If you did not create an account, ignore this message.` }),
  reset: (link) => ({ subject: 'Reset your MobiAd password', text: `We received a request to reset your password:\n\n${link}\n\nThis link expires in 30 minutes and works once. If you did not request this, ignore this message; your password has not changed.` }),
  teamInvite: (owner, role, link) => ({ subject: `${owner} invited you to MobiAd`, text: `${owner} invited you to join their MobiAd account as ${role === 'admin' ? 'a team admin' : 'a viewer'}.\n\nAccept and set your password:\n\n${link}\n\nThis link expires in 7 days. If you were not expecting it, ignore this message.` }),
  signupInvite: (role, code, link, days) => ({ subject: 'You are invited to the MobiAd private beta', text: `You have been invited to join the MobiAd private beta as ${role === 'publisher' ? 'a publisher (app developer)' : 'an advertiser'}.\n\nCreate your account here (the code is filled in for you):\n\n${link}\n\nYour invite code: ${code}\n\nThe code works once and expires in ${days} days. If you were not expecting this, ignore this message.` }),
  changed: () => ({ subject: 'Your MobiAd password was changed', text: 'Your password was just changed and all signed-in sessions were ended. If this was not you, reset your password immediately and contact support.' }),
  mfaOn: () => ({ subject: 'Two-factor authentication enabled', text: 'Two-factor authentication is now enabled on your MobiAd account.' }),
  mfaOff: () => ({ subject: 'Two-factor authentication disabled', text: 'Two-factor authentication was disabled on your MobiAd account. If this was not you, reset your password immediately.' }),
};
