import { Resend } from 'resend'

/**
 * Send a VIP invite email via Resend.
 * Returns { sent: true } or { sent: false, reason: string }.
 * Never throws — caller decides how to handle failure.
 *
 * Required env vars:
 *   RESEND_API_KEY   — API key from resend.com
 *   INVITE_EMAIL_FROM — verified sender address, e.g. "Life Warrior Coaching <invites@lwcvip.com>"
 *
 * Optional:
 *   APP_BASE_URL     — defaults to https://app.lwcvip.com
 */
/**
 * Send an AI coaching setup email after Stripe purchase.
 * Same Resend infrastructure as VIP invites, AI-specific copy.
 */
export async function sendAiSetupEmail({ to, firstName, setupUrl }) {
  const apiKey   = process.env.RESEND_API_KEY
  const fromAddr = process.env.INVITE_EMAIL_FROM

  if (!apiKey || !fromAddr) {
    console.warn('[email] RESEND_API_KEY or INVITE_EMAIL_FROM not set — AI setup email skipped')
    return { sent: false, reason: 'Email not configured on server.' }
  }

  const resend = new Resend(apiKey)

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#1e2a3a;padding:28px 32px;">
            <p style="margin:0;color:#f97316;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">
              WarriorFIT AI
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111827;">
              You're in, ${firstName}!
            </h1>
            <p style="margin:0 0 8px;font-size:15px;color:#4b5563;line-height:1.6;">
              Your AI coaching subscription is confirmed. Set up your account to get started with your personalized AI coach, food tracking, and habit tools.
            </p>
            <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
              Bookmark this email — it's your setup link if you ever need to come back.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#f97316;border-radius:8px;">
                  <a href="${setupUrl}"
                     style="display:inline-block;padding:14px 32px;color:#ffffff;
                            font-size:15px;font-weight:700;text-decoration:none;">
                    Set Up My Account →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
              If the button doesn't work, copy this link:<br>
              <a href="${setupUrl}" style="color:#f97316;word-break:break-all;">${setupUrl}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#9ca3af;">
              WarriorFIT AI · You're receiving this because you purchased AI coaching.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = `You're in, ${firstName}!\n\nYour AI coaching subscription is confirmed.\n\nSet up your account here:\n${setupUrl}\n\nBookmark this email — it's your setup link if you ever need to come back.`

  try {
    const { error } = await resend.emails.send({
      from:    fromAddr,
      to:      [to],
      subject: "You're in — set up your WarriorFIT AI coaching account",
      html,
      text,
    })

    if (error) {
      console.error('[email] Resend error (AI setup):', error.message ?? JSON.stringify(error))
      return { sent: false, reason: error.message ?? 'Resend returned an error.' }
    }

    console.log(`[email] AI setup email sent via Resend to ${to}`)
    return { sent: true }
  } catch (err) {
    console.error('[email] Resend exception (AI setup):', err.message)
    return { sent: false, reason: err.message ?? 'Unexpected email error.' }
  }
}

// Org owner invite — sent when a super admin invites someone to manage their
// own organization (as opposed to sendInviteEmail, which is the generic
// client/VIP invite). Same Resend send pattern, org-specific copy.
export async function sendOrgOwnerInviteEmail({ to, firstName, orgName, inviteUrl }) {
  const apiKey   = process.env.RESEND_API_KEY
  const fromAddr = process.env.INVITE_EMAIL_FROM

  if (!apiKey || !fromAddr) {
    console.warn('[email] RESEND_API_KEY or INVITE_EMAIL_FROM not set — org owner invite email skipped')
    return { sent: false, reason: 'Email not configured on server. Copy the invite link below.' }
  }

  const resend = new Resend(apiKey)

  // Derive logo URL from the invite URL origin so it always points to the right environment
  const logoUrl = new URL(inviteUrl).origin + '/logo.png'

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#1e2a3a;padding:24px 32px;text-align:center;">
            <img src="${logoUrl}" alt="WarriorFIT AI"
                 style="height:48px;width:auto;display:inline-block;" />
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111827;">
              Hi ${firstName},
            </h1>
            <p style="margin:0 0 8px;font-size:15px;color:#4b5563;line-height:1.6;">
              <strong>${orgName}</strong> has been set up for you on WarriorFit AI.
            </p>
            <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
              Click below to accept your invitation and set up your account.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#f97316;border-radius:8px;">
                  <a href="${inviteUrl}"
                     style="display:inline-block;padding:14px 32px;color:#ffffff;
                            font-size:15px;font-weight:700;text-decoration:none;">
                    Accept Invitation →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
              Once you log in, you'll be able to manage your organization, invite clients, and configure your AI coach.
            </p>
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
              If the button doesn't work, copy this link:<br>
              <a href="${inviteUrl}" style="color:#f97316;word-break:break-all;">${inviteUrl}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#9ca3af;">
              Questions? Reply to this email or contact jason@lwcvip.com
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = `Hi ${firstName},\n\n${orgName} has been set up for you on WarriorFit AI.\n\nClick below to accept your invitation and set up your account:\n${inviteUrl}\n\nOnce you log in, you'll be able to manage your organization, invite clients, and configure your AI coach.\n\nQuestions? Reply to this email or contact jason@lwcvip.com`

  try {
    const { error } = await resend.emails.send({
      from:    fromAddr,
      to:      [to],
      subject: `You've been invited to manage ${orgName} on WarriorFit AI`,
      html,
      text,
    })

    if (error) {
      console.error('[email] Resend error (org owner invite):', error.message ?? JSON.stringify(error))
      return { sent: false, reason: error.message ?? 'Resend returned an error.' }
    }

    console.log(`[email] Org owner invite sent via Resend to ${to}`)
    return { sent: true }
  } catch (err) {
    console.error('[email] Resend exception (org owner invite):', err.message)
    return { sent: false, reason: err.message ?? 'Unexpected email error.' }
  }
}

export async function sendInviteEmail({ to, firstName, inviteUrl }) {
  const apiKey   = process.env.RESEND_API_KEY
  const fromAddr = process.env.INVITE_EMAIL_FROM

  if (!apiKey || !fromAddr) {
    console.warn('[email] RESEND_API_KEY or INVITE_EMAIL_FROM not set — invite email skipped')
    return { sent: false, reason: 'Email not configured on server. Copy the invite link below.' }
  }

  const resend = new Resend(apiKey)

  // Derive logo URL from the invite URL origin so it always points to the right environment
  const logoUrl = new URL(inviteUrl).origin + '/logo.png'

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#1e2a3a;padding:24px 32px;text-align:center;">
            <img src="${logoUrl}" alt="WarriorFIT AI"
                 style="height:48px;width:auto;display:inline-block;" />
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111827;">
              Welcome, ${firstName}!
            </h1>
            <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
              You've been personally invited to join WarriorFIT AI coaching.
              Click the button below to set up your account and get started.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#f97316;border-radius:8px;">
                  <a href="${inviteUrl}"
                     style="display:inline-block;padding:14px 32px;color:#ffffff;
                            font-size:15px;font-weight:700;text-decoration:none;">
                    Set Up My Account →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
              This invite expires in 24 hours. If the button doesn't work, copy this link:<br>
              <a href="${inviteUrl}" style="color:#f97316;word-break:break-all;">${inviteUrl}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#9ca3af;">
              WarriorFIT AI · You're receiving this because an admin sent you a personal invite.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = `Welcome to WarriorFIT AI, ${firstName}!\n\nYou've been personally invited to join as a coaching client.\n\nSet up your account here:\n${inviteUrl}\n\nThis invite expires in 24 hours.`

  try {
    const { error } = await resend.emails.send({
      from:    fromAddr,
      to:      [to],
      subject: 'Set up your WarriorFIT AI account',
      html,
      text,
    })

    if (error) {
      console.error('[email] Resend error:', error.message ?? JSON.stringify(error))
      return { sent: false, reason: error.message ?? 'Resend returned an error.' }
    }

    console.log(`[email] Invite sent via Resend to ${to}`)
    return { sent: true }
  } catch (err) {
    console.error('[email] Resend exception:', err.message)
    return { sent: false, reason: err.message ?? 'Unexpected email error.' }
  }
}
