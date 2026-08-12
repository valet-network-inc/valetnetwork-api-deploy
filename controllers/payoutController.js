/**
 * payoutController
 *
 * Valet earnings + payout request flow. We do NOT move money — Rishi
 * sees the request on the admin dashboard's Payouts tab and sends
 * funds manually via the chosen method (Zelle, Venmo, or Cash App),
 * then flips the row's status to "sent" from the dashboard.
 *
 * Endpoints:
 *   GET   /api/valet/earnings           -> balances + all saved handles + active method
 *   PATCH /api/valet/payoutMethod       -> save a handle for a method (and optionally set as active)
 *   POST  /api/valet/requestPayout      -> create ValetPayout with active method, zero balance
 *   GET   /api/valet/payoutHistory      -> last N payouts for this valet (used by mobile app)
 *
 *   GET   /api/admin/payouts            -> all payouts for dashboard (filter by status)
 *   POST  /api/admin/payouts/:id/markPaid -> flip a payout to status='sent'
 */

const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

const axios = require('axios');
const User = require('../models/User');
const ValetPayout = require('../models/ValetPayout');

// Email notification config. Recipients are hardcoded since we control them
// (admin/owner emails, not user-supplied). Sender falls back to Resend's shared
// onboarding domain until valetnetwork.co is verified at resend.com/domains.
//
// The old valetnyc.co domain was lost in 2026 and has no MX, so anything
// addressed there is a black hole — do not reintroduce it here.
// Once valetnetwork.co is verified, set RESEND_FROM to alerts@valetnetwork.co
// and add rishi@valetnetwork.co to NOTIFY_RECIPIENTS.
const NOTIFY_RECIPIENTS = ['developer@valetnetwork.co'];
const RESEND_FROM = process.env.RESEND_FROM || 'ValetNYC Alerts <onboarding@resend.dev>';

const isEmail = (s) => /\S+@\S+\.\S+/.test(s);
const isPhone = (s) => /^\+?[\d()\-\s]{7,}$/.test(s);

const SUPPORTED_METHODS = ['zelle', 'venmo', 'cashapp'];

const METHOD_LABEL = {
    zelle: 'Zelle',
    venmo: 'Venmo',
    cashapp: 'Cash App',
};

const HANDLE_FIELD = {
    zelle: 'zelleHandle',
    venmo: 'venmoHandle',
    cashapp: 'cashappHandle',
};

// Strip leading '@' (Venmo) or '$' (CashApp) and trim. Validate per-method.
// Returns { ok: true, value } or { ok: false, message }.
const normalizeHandle = (method, raw) => {
    if (!raw || typeof raw !== 'string') {
        return { ok: false, message: 'Handle is required.' };
    }
    let value = raw.trim();
    if (method === 'zelle') {
        if (!isEmail(value) && !isPhone(value)) {
            return {
                ok: false,
                message: 'Zelle handle must be an email or phone number.',
            };
        }
        return { ok: true, value };
    }
    if (method === 'venmo') {
        if (value.startsWith('@')) value = value.slice(1);
        if (!/^[A-Za-z0-9_.\-]{2,30}$/.test(value)) {
            return {
                ok: false,
                message:
                    'Venmo handle must be a username (letters, numbers, _ . -), 2–30 characters.',
            };
        }
        return { ok: true, value };
    }
    if (method === 'cashapp') {
        if (value.startsWith('$')) value = value.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9]{0,19}$/.test(value)) {
            return {
                ok: false,
                message:
                    'Cash App $cashtag must start with a letter and be 1–20 characters.',
            };
        }
        return { ok: true, value };
    }
    return { ok: false, message: 'Unsupported payout method.' };
};

const sendEmailPayoutNotification = async (payout, valet) => {
    if (!process.env.RESEND_API_KEY) {
        // Notification is best-effort. Don't fail the request if not configured.
        console.warn('RESEND_API_KEY not set — skipping payout email notification');
        return;
    }
    try {
        const env =
            process.env.STRIPE_API_KEY &&
            process.env.STRIPE_API_KEY.includes('sk_live')
                ? 'PRODUCTION'
                : 'DEVELOPMENT';
        const dollarAmount = (payout.amount / 100).toFixed(2);
        const valetName =
            `${valet.firstName || ''} ${valet.lastName || ''}`.trim() || '(no name)';
        const requestedAt = new Date(payout.createdAt || Date.now()).toLocaleString(
            'en-US',
            { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }
        );

        const methodLabel = METHOD_LABEL[payout.method] || payout.method;
        const handleDisplay =
            payout.method === 'venmo'
                ? `@${payout.handle}`
                : payout.method === 'cashapp'
                ? `$${payout.handle}`
                : payout.handle;

        const subject = `[ValetNYC] Payout requested — ${valetName}, $${dollarAmount} (${methodLabel})`;

        const text = [
            `Valet:       ${valetName}`,
            `Phone:       ${valet.phone || '—'}`,
            `Amount:      $${dollarAmount}`,
            `Method:      ${methodLabel}`,
            `Handle:      ${handleDisplay}`,
            `Payout ID:   ${payout._id.toString()}`,
            `Requested:   ${requestedAt} ET`,
            `Environment: ${env}`,
            ``,
            `Send the funds via ${methodLabel} to the handle above. No further action needed in the app.`,
        ].join('\n');

        const html = `
            <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; padding: 24px; color: #111;">
                <h2 style="color:#113524; margin:0 0 16px 0;">Payout requested</h2>
                <table style="border-collapse:collapse; width:100%; font-size:14px;">
                    <tr><td style="padding:6px 0; color:#666; width:120px;">Valet</td><td style="padding:6px 0; font-weight:600;">${valetName}</td></tr>
                    <tr><td style="padding:6px 0; color:#666;">Phone</td><td style="padding:6px 0;">${valet.phone || '—'}</td></tr>
                    <tr><td style="padding:6px 0; color:#666;">Amount</td><td style="padding:6px 0; font-weight:700; font-size:20px; color:#113524;">$${dollarAmount}</td></tr>
                    <tr><td style="padding:6px 0; color:#666;">Method</td><td style="padding:6px 0; font-weight:600;">${methodLabel}</td></tr>
                    <tr><td style="padding:6px 0; color:#666;">Handle</td><td style="padding:6px 0; font-family:monospace; background:#F3F4F6; padding-left:8px; padding-right:8px; border-radius:6px; display:inline-block;">${handleDisplay}</td></tr>
                    <tr><td style="padding:6px 0; color:#666;">Requested</td><td style="padding:6px 0;">${requestedAt} ET</td></tr>
                    <tr><td style="padding:6px 0; color:#666;">Payout ID</td><td style="padding:6px 0; font-family:monospace; font-size:12px; color:#666;">${payout._id.toString()}</td></tr>
                    <tr><td style="padding:6px 0; color:#666;">Environment</td><td style="padding:6px 0;">${env}</td></tr>
                </table>
                <p style="margin-top:24px; color:#444; font-size:14px;">
                    Send the funds via <strong>${methodLabel}</strong> to the handle above. No further action needed in the app.
                </p>
            </div>
        `.trim();

        await axios.post(
            'https://api.resend.com/emails',
            {
                from: RESEND_FROM,
                to: NOTIFY_RECIPIENTS,
                subject,
                text,
                html,
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 8000,
            }
        );
        console.log(
            'Payout email sent for',
            payout._id.toString(),
            '->',
            NOTIFY_RECIPIENTS.join(', ')
        );
    } catch (err) {
        // Non-fatal — payout request succeeds even if email ping fails
        console.error(
            'Payout email send failed:',
            err.response?.data || err.message
        );
    }
};

exports.getEarnings = async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) {
            return res
                .status(400)
                .json({ success: false, message: 'userId is required' });
        }
        const user = await User.findById(userId).select(
            'currentBalance totalEarnings currentTipsBalance totalTips payoutMethod zelleHandle venmoHandle cashappHandle isValet'
        );
        if (!user) {
            return res
                .status(404)
                .json({ success: false, message: 'User not found' });
        }
        if (!user.isValet) {
            return res
                .status(403)
                .json({ success: false, message: 'Earnings are only available to valet accounts' });
        }
        const currentBalance = user.currentBalance || 0;
        const currentTipsBalance = user.currentTipsBalance || 0;
        const totalEarnings = user.totalEarnings || 0;
        const totalTips = user.totalTips || 0;
        res.status(200).json({
            success: true,
            // Granular fields the mobile earnings card needs to render the four-box layout
            currentBalance,                  // base earnings only (cents)
            currentTipsBalance,              // tips only (cents)
            currentTotal: currentBalance + currentTipsBalance,   // available for next payout
            totalEarnings,                   // lifetime base earnings (cents)
            totalTips,                       // lifetime tips (cents)
            lifetimeTotal: totalEarnings + totalTips,            // lifetime everything
            payoutMethod: user.payoutMethod || null,
            zelleHandle: user.zelleHandle || null,
            venmoHandle: user.venmoHandle || null,
            cashappHandle: user.cashappHandle || null,
        });
    } catch (err) {
        console.error('getEarnings error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch earnings' });
    }
};

exports.updatePayoutMethod = async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'userId is required',
            });
        }

        // New shape: { userId, method, handle, setActive? }
        // Old shape (back-compat with build 6 archive): { userId, zelleHandle }
        let method = req.body.method;
        let rawHandle = req.body.handle;
        const setActive = req.body.setActive !== false; // default true
        if (!method && req.body.zelleHandle !== undefined) {
            method = 'zelle';
            rawHandle = req.body.zelleHandle;
        }

        if (!SUPPORTED_METHODS.includes(method)) {
            return res.status(400).json({
                success: false,
                message: `method must be one of: ${SUPPORTED_METHODS.join(', ')}`,
            });
        }

        const normalized = normalizeHandle(method, rawHandle);
        if (!normalized.ok) {
            return res.status(400).json({
                success: false,
                message: normalized.message,
            });
        }

        const update = { [HANDLE_FIELD[method]]: normalized.value };
        if (setActive) update.payoutMethod = method;

        const user = await User.findByIdAndUpdate(userId, update, {
            new: true,
        }).select(
            'payoutMethod zelleHandle venmoHandle cashappHandle'
        );
        if (!user) {
            return res
                .status(404)
                .json({ success: false, message: 'User not found' });
        }
        res.status(200).json({
            success: true,
            payoutMethod: user.payoutMethod,
            zelleHandle: user.zelleHandle || null,
            venmoHandle: user.venmoHandle || null,
            cashappHandle: user.cashappHandle || null,
        });
    } catch (err) {
        console.error('updatePayoutMethod error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to update payout method',
        });
    }
};

exports.requestPayout = async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res
                .status(400)
                .json({ success: false, message: 'userId is required' });
        }
        const valet = await User.findById(userId);
        if (!valet) {
            return res
                .status(404)
                .json({ success: false, message: 'User not found' });
        }
        if (!valet.isValet) {
            return res
                .status(403)
                .json({ success: false, message: 'Only valet accounts can request payouts' });
        }
        // Pick the active method's handle. Fall back to whichever handle is
        // saved if payoutMethod somehow wasn't set (legacy users with only
        // zelleHandle from before multi-method support).
        let activeMethod = valet.payoutMethod;
        if (!activeMethod) {
            if (valet.zelleHandle) activeMethod = 'zelle';
            else if (valet.venmoHandle) activeMethod = 'venmo';
            else if (valet.cashappHandle) activeMethod = 'cashapp';
        }
        if (!activeMethod || !SUPPORTED_METHODS.includes(activeMethod)) {
            return res.status(400).json({
                success: false,
                message:
                    'Choose a payout method (Zelle, Venmo, or Cash App) before requesting a payout.',
            });
        }
        const activeHandle = valet[HANDLE_FIELD[activeMethod]];
        if (!activeHandle) {
            return res.status(400).json({
                success: false,
                message: `Add your ${METHOD_LABEL[activeMethod]} handle before requesting a payout.`,
            });
        }
        // Total payout = base earnings + tips (both currently sitting on the
        // valet's account, paid out together).
        const earningsCents = valet.currentBalance || 0;
        const tipsCents = valet.currentTipsBalance || 0;
        const balance = earningsCents + tipsCents;
        if (balance <= 0) {
            return res.status(400).json({
                success: false,
                message: 'No balance available to pay out.',
            });
        }

        // Create the payout record. amount is the combined total. The
        // breakdown (earnings vs tips) is also captured for the admin
        // dashboard so we can see "of $X paid out, $Y was tips".
        const payout = await ValetPayout.create({
            valet: valet._id,
            valetSnapshot: {
                firstName: valet.firstName,
                lastName: valet.lastName,
                phone: valet.phone,
            },
            amount: balance,
            earningsAmount: earningsCents,
            tipsAmount: tipsCents,
            method: activeMethod,
            handle: activeHandle,
            status: 'requested',
        });

        // Zero out both balances. The lifetime counters
        // (totalEarnings, totalTips) stay unchanged.
        await User.findByIdAndUpdate(valet._id, {
            currentBalance: 0,
            currentTipsBalance: 0,
        });

        // No email notification — the admin sees this on the dashboard's
        // Payouts tab and acts on it from there. (sendEmailPayoutNotification
        // is kept in this file for now in case email is re-enabled later.)

        res.status(200).json({
            success: true,
            message: 'Payout requested. You will receive funds within 1–2 business days.',
            payout: {
                id: payout._id,
                amount: payout.amount,
                method: payout.method,
                handle: payout.handle,
                requestedAt: payout.createdAt,
            },
        });
    } catch (err) {
        console.error('requestPayout error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to request payout',
        });
    }
};

// ==================== ADMIN ====================

// GET /api/admin/payouts?status=requested|sent|cancelled|all&limit=N
// Returns all payouts (or filtered by status), newest first, with the
// valet's contact info populated. Used by the dashboard's Payouts tab.
exports.listAllPayouts = async (req, res) => {
    try {
        const { status = 'requested', limit = 200 } = req.query;
        const filter = {};
        if (status && status !== 'all') {
            if (!['requested', 'sent', 'cancelled'].includes(status)) {
                return res.status(400).json({
                    success: false,
                    message:
                        'status must be one of: requested, sent, cancelled, all',
                });
            }
            filter.status = status;
        }
        const payouts = await ValetPayout.find(filter)
            .sort({ createdAt: -1 })
            .limit(Math.min(parseInt(limit, 10) || 200, 500))
            .populate('valet', 'firstName lastName phone profileImage')
            .lean();

        // Normalize the display handle (prefix '@' for venmo, '$' for cashapp)
        const decorated = payouts.map((p) => {
            const handleDisplay =
                p.method === 'venmo'
                    ? `@${p.handle}`
                    : p.method === 'cashapp'
                    ? `$${p.handle}`
                    : p.handle;
            const methodLabel = METHOD_LABEL[p.method] || p.method;
            const valetName =
                `${p.valetSnapshot?.firstName || p.valet?.firstName || ''} ${
                    p.valetSnapshot?.lastName || p.valet?.lastName || ''
                }`.trim() || '(no name)';
            return {
                ...p,
                handleDisplay,
                methodLabel,
                valetName,
                valetPhone: p.valetSnapshot?.phone || p.valet?.phone || '',
            };
        });

        res.status(200).json({ success: true, payouts: decorated });
    } catch (err) {
        console.error('listAllPayouts error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to list payouts',
        });
    }
};

// POST /api/admin/payouts/:id/markPaid
// Flips a payout's status to 'sent' and stamps sentAt. Optionally accepts
// { adminNote } for a transaction reference. Idempotent: marking an already-
// sent payout returns the existing record without changing sentAt.
exports.markPayoutPaid = async (req, res) => {
    try {
        const { id } = req.params;
        const { adminNote } = req.body || {};
        const existing = await ValetPayout.findById(id);
        if (!existing) {
            return res
                .status(404)
                .json({ success: false, message: 'Payout not found' });
        }
        if (existing.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                message: 'Cannot mark a cancelled payout as paid',
            });
        }
        if (existing.status === 'sent') {
            return res
                .status(200)
                .json({ success: true, payout: existing, alreadySent: true });
        }
        existing.status = 'sent';
        existing.sentAt = new Date();
        if (adminNote) existing.adminNote = String(adminNote).slice(0, 500);
        await existing.save();
        res.status(200).json({ success: true, payout: existing });
    } catch (err) {
        console.error('markPayoutPaid error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to mark payout as paid',
        });
    }
};

exports.getPayoutHistory = async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) {
            return res
                .status(400)
                .json({ success: false, message: 'userId is required' });
        }
        const payouts = await ValetPayout.find({ valet: userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.status(200).json({ success: true, payouts });
    } catch (err) {
        console.error('getPayoutHistory error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payout history',
        });
    }
};
