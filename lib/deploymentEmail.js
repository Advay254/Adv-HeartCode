'use strict';

/**
 * v1.2.7: the "your site is live" confirmation email, extracted verbatim
 * from the post-commit block of lib/finalizeDeployment.js so the admin
 * test-deploy flow (routes/adminTestDeploy.js) sends it through EXACTLY the
 * same code path -- the same per-type email_templates lookup, the same
 * variable set, the same fallback to the generic email -- instead of a
 * second copy that could quietly drift from what real customers get.
 * Testing a type's email template is one of the main reasons a test deploy
 * exists, so it has to be the real thing.
 *
 * Behavior for real deployments is unchanged: finalizeDeployment calls this
 * with no subjectPrefix and gets back the same result it computed inline
 * before.
 */

const { sendSiteReadyEmail, sendCustomEmail } = require('./email');
const { getActiveEmailTemplate, buildEmailVariables, renderEmailContent } = require('./emailTemplates');

/**
 * Formats a deployed_sites.deployed_at (TIMESTAMPTZ) into the
 * {{deployed_at}} system variable email templates can reference. A locale
 * string reads naturally in an email body; falls back to String() rather
 * than throwing -- this runs after a real deployment already succeeded, so
 * a formatting hiccup must never be what makes the confirmation fail.
 */
function formatDeployedAt(date) {
  try {
    return new Date(date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (err) {
    return String(date);
  }
}

/**
 * Sends the confirmation email. Returns { sentCustom } (true when the type's
 * own email template was used, false for the generic fallback). THROWS if
 * the actual send fails -- callers decide what a send failure means (the
 * real pipeline logs and moves on because the site is already live; the
 * test flow reports it to the admin, whose whole job there is to find out).
 *
 * The custom-template attempt (lookup, build AND its send) sits inside its
 * OWN inner try/catch, exactly as it did inline before: any failure there
 * -- a DB hiccup, a bad template shape, or the custom email failing to
 * send -- falls back to the generic email rather than no email at all. Only
 * a failure of the final generic send propagates to the caller.
 *
 * `subjectPrefix` (default '') is prepended to the final subject on either
 * path -- the test flow passes '[TEST] '.
 */
async function sendDeploymentConfirmationEmail({
  websiteTypeId,
  websiteTypeName,
  clientEmail,
  siteUrl,
  deployedAt,
  sitePassword,
  rawFieldValues,
  aiOutputValues,
  subjectPrefix = ''
}) {
  let sentCustom = false;
  try {
    const emailTemplate = await getActiveEmailTemplate(websiteTypeId);
    if (emailTemplate) {
      const systemVars = {
        site_url: siteUrl,
        client_email: clientEmail,
        website_type_name: websiteTypeName || '',
        deployed_at: formatDeployedAt(deployedAt),
        site_password: sitePassword || ''
      };
      const { flatValues, arrayValues } = await buildEmailVariables(
        websiteTypeId,
        systemVars,
        rawFieldValues,
        aiOutputValues
      );
      const { subject, html } = renderEmailContent(emailTemplate, flatValues, arrayValues);
      await sendCustomEmail(clientEmail, `${subjectPrefix}${subject}`, html);
      sentCustom = true;
    }
  } catch (templateErr) {
    console.error('[FINALIZE] Failed to build/send custom email template, falling back to generic email:', templateErr.message);
  }

  if (!sentCustom) {
    await sendSiteReadyEmail(clientEmail, siteUrl, sitePassword, subjectPrefix);
  }

  return { sentCustom };
}

module.exports = { sendDeploymentConfirmationEmail, formatDeployedAt };
