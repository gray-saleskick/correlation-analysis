const ADMIN_EMAILS = ["gray@saleskick.com"];

export function isAdmin(email?: string): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

export function hasWebhookAccess(email?: string): boolean {
  // Easy to enable for all users later: just return true
  return isAdmin(email);
}
