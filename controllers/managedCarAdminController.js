/**
 * Admin surface for the cars we are holding on the flat plans.
 *
 * Rishi is not technical and eats the cost of every ticket, so "the backend
 * knows" is not enough — there has to be one screen that answers, in plain
 * words: which cars are we holding, where are they, when do we move each one,
 * and which ones are we blind on. A blind car is a ticket waiting to happen,
 * and the fix for it is a human typing what the sign says, which is the last
 * endpoint here.
 */

const CurbCustody = require('../models/CurbCustody');
const Subscription = require('../models/Subscription');
const sweepWindows = require('../services/sweepWindows');
const curbCustody = require('../services/curbCustody');
const operatorAlert = require('../services/operatorAlert');

const PLAN_LABEL = {
    home_garage: 'Fixed garage ($250)',
    valet_anywhere: 'Valet anywhere ($300)',
};

// Worst first: a car being swept right now beats a car we simply cannot read.
const STATE_ORDER = { blind: 0, moving: 1, resolving: 2, armed: 3, releasing: 4 };

/**
 * GET /api/admin/managed-cars
 *
 * One row per car under management, plus the counts the tab header shows so
 * nobody has to derive "4 armed, 1 blind" on the client.
 */
exports.listManagedCars = async (req, res) => {
    try {
        const includeClosed = String(req.query.includeClosed || '') === 'true';
        const now = new Date();
        const query = includeClosed ? {} : { closedAt: { $exists: false } };

        const rows = await CurbCustody.find(query)
            .sort({ openedAt: -1 })
            .limit(Math.min(parseInt(req.query.limit, 10) || 200, 500))
            .populate('customer', 'firstName lastName phone')
            .populate('valet', 'firstName lastName phone')
            .lean();

        const cars = rows.map((c) => {
            const windows = (c.rules && c.rules.windows) || [];
            const next = windows.length ? sweepWindows.nextSweep(windows, now) : null;
            const heldHours = Math.round(
                (now.getTime() - new Date(c.spotSince || c.openedAt).getTime()) / 3600000
            );
            return {
                id: c._id,
                state: c.state,
                plan: PLAN_LABEL[c.tier] || c.tier,
                tier: c.tier,
                customerName:
                    [c.customer?.firstName, c.customer?.lastName].filter(Boolean).join(' ').trim() ||
                    c.customer?.phone ||
                    'A customer',
                customerPhone: c.customer?.phone || null,
                valetName:
                    [c.valet?.firstName, c.valet?.lastName].filter(Boolean).join(' ').trim() || null,
                where: c.spot?.streetAddress || null,
                lat: c.spot?.lat,
                lng: c.spot?.lng,
                heldHours,
                keysWith: c.keysWith,
                // The plain-words answer, because that is what the tab is for.
                sweepLabel: windows.length
                    ? sweepWindows.describeWindows(windows)
                    : c.rules?.source === 'none_on_sign'
                    ? 'No street cleaning on this block'
                    : c.rules?.source === 'off_street'
                    ? 'Off-street — no sweeps apply'
                    : 'We do not know yet',
                nextMoveAt: next ? next.at : null,
                rulesSource: c.rules?.source || 'unknown',
                disputed: !!c.rules?.disputed,
                disputeDetail: c.rules?.disputeDetail || null,
                droppedWindows: c.rules?.droppedWindows || 0,
                movesThisPeriod: c.movesThisPeriod || 0,
                lastMoveAt: c.lastMoveAt || null,
                planEndedAt: c.planEndedAt || null,
                currentOrder: c.currentOrder,
                spotCount: (c.spots || []).length,
                openedAt: c.openedAt,
                closedAt: c.closedAt || null,
                closeReason: c.closeReason || null,
            };
        });

        cars.sort(
            (a, b) =>
                (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
                new Date(a.nextMoveAt || 0) - new Date(b.nextMoveAt || 0)
        );

        const counts = cars.reduce((acc, c) => {
            if (c.closedAt) return acc;
            acc[c.state] = (acc[c.state] || 0) + 1;
            return acc;
        }, {});

        return res.json({ success: true, cars, counts, count: cars.length });
    } catch (err) {
        console.error('listManagedCars error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'Failed to list managed cars.' });
    }
};

/** GET /api/admin/managed-cars/:id — the full history, for a ticket dispute. */
exports.getManagedCar = async (req, res) => {
    try {
        const car = await CurbCustody.findById(req.params.id)
            .populate('customer', 'firstName lastName phone')
            .populate('valet', 'firstName lastName phone')
            .lean();
        if (!car) return res.status(404).json({ success: false, message: 'Not found' });
        const sub = await Subscription.findById(car.subscription)
            .select('tier interval amountCents status currentPeriodEnd')
            .lean();
        // spots[] is append-only precisely so this answer exists: if a ticket is
        // contested weeks later, the ParkingNote for that block has been
        // overwritten and its sign photo wiped by the 30-day expiry cron.
        return res.json({ success: true, car, subscription: sub });
    } catch (err) {
        console.error('getManagedCar error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * PUT /api/admin/managed-cars/:id/rules
 * { streetCleaning: [{ day, startTime, endTime }], note? }
 *
 * The remediation for a blind car. Takes the same shape a valet's sign photo
 * produces, so one converter serves both.
 */
exports.setManagedCarRules = async (req, res) => {
    try {
        const { streetCleaning, note } = req.body;
        if (!Array.isArray(streetCleaning)) {
            return res.status(400).json({
                success: false,
                message: 'streetCleaning must be an array of { day, startTime, endTime }.',
            });
        }
        // An empty list cannot be an answer here.
        //
        // setOperatorRules would happily write source 'operator' with zero
        // windows and mark the car ARMED — so it would read as handled on this
        // very screen, schedule no move, and stop raising the blind alarm that
        // is the only thing standing between it and a ticket. A car that looks
        // fixed and is not is worse than one that is obviously broken. If a
        // valet genuinely read the sign and there is no cleaning on that block,
        // that is `sweepDataStatus` on the note, not a blank form here.
        if (!streetCleaning.length) {
            return res.status(400).json({
                success: false,
                message:
                    'Add at least one sweep window. If this block genuinely has no street ' +
                    'cleaning, that has to come from a valet at the sign, not from here.',
            });
        }
        const converted = sweepWindows.toSweepWindows(streetCleaning);
        if (streetCleaning.length && !converted.windows.length) {
            return res.status(400).json({
                success: false,
                message:
                    'None of those windows could be read. Days are 0-6 (0 = Sunday) and times are ' +
                    '24-hour "HH:MM".',
            });
        }
        const car = await curbCustody.setOperatorRules({
            custodyId: req.params.id,
            streetCleaning,
            note,
        });
        if (!car) return res.status(404).json({ success: false, message: 'Not found' });
        return res.json({
            success: true,
            car: { id: car._id, state: car.state, rules: car.rules },
            reads: sweepWindows.describeWindows(converted.windows),
        });
    } catch (err) {
        console.error('setManagedCarRules error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/** POST /api/admin/managed-cars/:id/close — the car came back and we missed it. */
exports.closeManagedCar = async (req, res) => {
    try {
        const car = await CurbCustody.findById(req.params.id);
        if (!car) return res.status(404).json({ success: false, message: 'Not found' });
        await curbCustody.close({ custody: car, reason: 'operator' });
        return res.json({ success: true });
    } catch (err) {
        console.error('closeManagedCar error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/admin/managed-cars/:id/request-keys
 *
 * Ask for the keys back ON THE CUSTOMER'S BEHALF.
 *
 * The customer-facing button exists on iOS and is being built for web, but a
 * customer can always reach us by phone or chat before either is in their hands
 * — and telling somebody we are holding their car keys and they will have to
 * wait for an app update is not an answer. This is the same job the customer's
 * own tap creates, placed by a person instead.
 */
exports.requestKeysForCustomer = async (req, res) => {
    try {
        const custody = await CurbCustody.findById(req.params.id).select('customer').lean();
        if (!custody) return res.status(404).json({ success: false, message: 'Not found' });
        const custodyController = require('./custodyController');
        // Reuse the customer path exactly, so an operator-placed request and a
        // customer-placed one are the same object with the same guards — there
        // is no second way for this to behave.
        req.body = { userId: String(custody.customer) };
        return custodyController.requestKeys(req, res);
    } catch (err) {
        console.error('requestKeysForCustomer error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/** GET /api/admin/ops-alerts — the worklist. */
exports.listOpsAlerts = async (req, res) => {
    try {
        const alerts = await operatorAlert.listOpen({
            limit: parseInt(req.query.limit, 10) || 100,
        });
        return res.json({ success: true, alerts, count: alerts.length });
    } catch (err) {
        console.error('listOpsAlerts error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/** POST /api/admin/ops-alerts/:id/ack */
exports.ackOpsAlert = async (req, res) => {
    try {
        const alert = await operatorAlert.ackAlert({
            id: req.params.id,
            by: req.body.by,
            note: req.body.note,
        });
        if (!alert) return res.status(404).json({ success: false, message: 'Not found' });
        return res.json({ success: true, alert });
    } catch (err) {
        console.error('ackOpsAlert error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
