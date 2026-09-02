/**
 * A fixed-window counter, held in this process's memory.
 *
 * Written by hand rather than pulled in because there is no rate-limit package
 * in package.json and the share link needed one tonight. Render runs a single
 * instance, so one process's memory is the whole picture; if that ever stops
 * being true this has to move to Mongo or Redis before it means anything.
 *
 * Losing the counts is acceptable — a restart hands an attacker a fresh window,
 * which is a far smaller problem than a limiter that can crash the API. So
 * nothing in here throws: an unkeyable request is simply let through and left
 * to the endpoint's own checks.
 *
 * Because the window reopens, this is burst control and only that. Anything
 * guarding a guessable secret needs an absolute, non-renewing cap of its own —
 * see `shareVerifyAttempts` on the Order.
 */

// Windows are dropped as they are touched, but a key that is never asked about
// again would sit in the Map forever. Sweep on write, and only occasionally.
const SWEEP_EVERY = 500;

/**
 * `countWhen` is handed the finished response and decides whether the request
 * should have cost anything. Default: everything counts.
 *
 * Every request is charged on the way IN and refunded on 'finish' if
 * `countWhen` says it was free. Charging only on 'finish' reads better and is
 * wrong: nothing has landed yet while a burst is in flight, so two hundred
 * simultaneous guesses all pass a counter still reading zero. Node runs this
 * function to completion before it touches the next request, so incrementing
 * here is the only point in the cycle where the count cannot be raced.
 *
 * The refund is what keeps a doorman who types the code correctly from
 * spending one of his tries doing it.
 */
module.exports = ({ windowMs, max, keyFrom, message, countWhen }) => {
    const windows = new Map();   // key -> { count, resetAt }
    let writesSinceSweep = 0;

    const freshWindow = (key, now) => {
        const window = { count: 0, resetAt: now + windowMs };
        windows.set(key, window);

        if (++writesSinceSweep >= SWEEP_EVERY) {
            writesSinceSweep = 0;
            for (const [k, w] of windows) {
                if (w.resetAt <= now) windows.delete(k);
            }
        }
        return window;
    };

    return (req, res, next) => {
        let key;
        try {
            key = keyFrom(req);
        } catch (err) {
            console.error('Rate limit key lookup failed:', err.message);
            return next();
        }
        if (!key) return next();

        const now = Date.now();
        const live = windows.get(key);
        const window = !live || live.resetAt <= now ? freshWindow(key, now) : live;

        if (window.count >= max) {
            // Seconds, because that is what a human-facing "try again in…"
            // needs and the only client is a person staring at a keypad.
            const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                success: false,
                message: message || 'Too many requests. Please wait and try again.',
                retryAfterSeconds: retryAfter,
            });
        }

        window.count += 1;

        res.on('finish', () => {
            if (!countWhen || countWhen(res)) return;
            // Refund, but only into the window that was actually charged. If
            // it has already rolled the debt went with it, and touching the
            // new one would credit a window that never paid.
            const current = windows.get(key);
            if (current === window && current.count > 0) current.count -= 1;
        });

        return next();
    };
};
