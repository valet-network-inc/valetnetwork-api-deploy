/**
 * operatorAlert — the one place an alert aimed at a HUMAN goes.
 *
 * A managed car is one we hold on the street and move before every sweep. When
 * that goes wrong the cost is a $65 Brooklyn ticket the company eats, so the
 * alarm is the deliverable rather than a nice-to-have. Which means it has to
 * survive the three ways alarms usually die:
 *
 *   1. NOBODY IS LISTENING. `SLACK_WEBHOOK_URL` is set in production today, but
 *      both existing copies of sendSlackNotification return silently when it is
 *      not, and a webhook pointed at an abandoned channel looks identical to a
 *      working one. So anything at 'page' severity ALSO goes to a mailbox the
 *      company definitely owns.
 *   2. IT REPEATS UNTIL IT IS NOISE. Dedupe is the unique index on
 *      {kind, custody, dateKey}, not a read-then-write check — a tick that runs
 *      every 60 seconds across a 50-minute firing window cannot deduplicate
 *      itself in application logic. Note that services/parkingAlerts.js gets
 *      this wrong twice over: it is registered nowhere, and both its dedupe
 *      stamps are undeclared paths that mongoose's strict mode silently drops.
 *      Had it ever been started it would have re-sent every minute.
 *   3. IT BREAKS THE THING IT WAS WATCHING. Nothing here throws. Every step is
 *      independently caught. An alert must never be able to fail the action it
 *      describes — a valet parking a car does not care that Slack is down.
 */

const axios = require('axios');

const OpsAlert = require('../models/OpsAlert');

const SEVERITY = { WARN: 'warn', PAGE: 'page' };

const RESEND_API = 'https://api.resend.com/emails';
const RESEND_FROM = process.env.RESEND_FROM || 'noreply@valetnetwork.co';
const OPS_EMAIL = process.env.OPS_ALERT_EMAIL || 'developer@valetnyc.co';

const escapeHtml = (s) =>
    String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

/**
 * Post to Slack. Mirrors the payload shape of
 * controllers/notificationController.js sendSlackNotification so alerts from
 * this service look like every other alert in the channel.
 */
const postSlack = async ({ severity, title, detail, payload }) => {
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) {
        console.warn('operatorAlert: SLACK_WEBHOOK_URL not set — skipping:', title);
        return false;
    }
    const environment = process.env.NODE_ENV || 'development';
    const icon = severity === SEVERITY.PAGE ? ':rotating_light:' : ':warning:';
    await axios.post(
        url,
        {
            text: `${icon} *[${environment.toUpperCase()}] ${title}*\n${detail || ''}`,
            attachments: [
                {
                    color: severity === SEVERITY.PAGE ? 'danger' : 'warning',
                    fields: Object.entries(payload || {}).map(([key, value]) => ({
                        title: key,
                        value:
                            typeof value === 'object'
                                ? JSON.stringify(value, null, 2)
                                : String(value),
                        short: false,
                    })),
                },
            ],
        },
        { timeout: 5000 }
    );
    return true;
};

/**
 * Email the ops mailbox. Only for 'page' — a warn that also lands in an inbox
 * trains everyone to filter the inbox.
 */
const sendEmail = async ({ title, detail, payload }) => {
    if (!process.env.RESEND_API_KEY) {
        console.warn('operatorAlert: RESEND_API_KEY not set — skipping email:', title);
        return false;
    }
    const rows = Object.entries(payload || {})
        .map(
            ([k, v]) =>
                `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(k)}</td>` +
                `<td style="padding:4px 0"><code>${escapeHtml(
                    typeof v === 'object' ? JSON.stringify(v) : v
                )}</code></td></tr>`
        )
        .join('');
    await axios.post(
        RESEND_API,
        {
            from: RESEND_FROM,
            to: [OPS_EMAIL],
            subject: `[Valet Network] ${title}`,
            html:
                `<p style="font:15px/1.5 -apple-system,sans-serif">${escapeHtml(detail || '')}</p>` +
                `<table style="font:13px/1.5 -apple-system,sans-serif">${rows}</table>`,
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        }
    );
    return true;
};

/**
 * Raise an alert. Never throws.
 *
 * Returns { deduped: true } when this exact alert has already been raised for
 * this car today — the duplicate-key error IS the dedupe, which is why the row
 * is written FIRST and the notifications are sent only if the write won.
 */
async function raise({
    kind,
    severity = SEVERITY.WARN,
    custody,
    order,
    customer,
    dateKey,
    title,
    detail,
    payload,
}) {
    let alert = null;
    try {
        alert = await OpsAlert.create({
            kind,
            severity,
            custody,
            order,
            customer,
            dateKey,
            title,
            detail,
            payload,
        });
    } catch (err) {
        if (err && err.code === 11000) {
            // Already raised for this car today. Exactly what the index is for.
            return { deduped: true };
        }
        // A failed write must not swallow the alert itself — a car about to take
        // a ticket is worth a Slack message even if we cannot record it.
        console.error('operatorAlert: could not record alert:', err.message);
    }

    let slack = false;
    let email = false;
    try {
        slack = await postSlack({ severity, title, detail, payload });
    } catch (err) {
        console.error('operatorAlert: Slack post failed:', err.message);
    }
    if (severity === SEVERITY.PAGE) {
        try {
            email = await sendEmail({ title, detail, payload });
        } catch (err) {
            console.error('operatorAlert: email failed:', err.message);
        }
    }

    console.log(
        `operatorAlert[${severity}] ${kind}: ${title}${detail ? ` — ${detail}` : ''}`
    );
    return { alerted: true, alertId: alert && alert._id, slack, email };
}

/** Mark one alert handled. Returns the updated row, or null. */
async function ackAlert({ id, by, note }) {
    try {
        return await OpsAlert.findByIdAndUpdate(
            id,
            {
                acknowledgedAt: new Date(),
                acknowledgedBy: by || 'admin',
                acknowledgedNote: note || '',
            },
            { new: true }
        );
    } catch (err) {
        console.error('operatorAlert: ack failed:', err.message);
        return null;
    }
}

/** The inbox: everything unacknowledged, pages first, newest first. */
async function listOpen({ limit = 100 } = {}) {
    try {
        return await OpsAlert.find({ acknowledgedAt: { $exists: false } })
            .sort({ severity: 1, createdAt: -1 }) // 'page' < 'warn' alphabetically
            .limit(Math.min(limit, 500))
            .populate('customer', 'firstName lastName phone')
            .lean();
    } catch (err) {
        console.error('operatorAlert: listOpen failed:', err.message);
        return [];
    }
}

module.exports = { SEVERITY, raise, ackAlert, listOpen };
