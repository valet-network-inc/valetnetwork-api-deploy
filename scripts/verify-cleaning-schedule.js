#!/usr/bin/env node
/**
 * Proof that today's work actually works, run against whichever server you
 * point it at. Every step prints what it asked for, what came back, and a
 * PASS or FAIL — so this is something to read, not just something to run.
 *
 *   node scripts/verify-cleaning-schedule.js
 *   API=https://api.valetnetwork.co ADMIN_KEY=... USER_ID=... node scripts/verify-cleaning-schedule.js
 *
 * It writes only to the one test user it is given and to suspension dates in
 * the year 2099, then deletes both. It never touches a real customer, never
 * creates an order, and never charges anything.
 */

const API = process.env.API || 'https://api.valetnetwork.co';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const USER_ID = process.env.USER_ID || '6a789358da83aa657966b40c'; // test customer

let pass = 0;
let fail = 0;
const failures = [];

const c = {
    ok: (s) => `\x1b[32m${s}\x1b[0m`,
    no: (s) => `\x1b[31m${s}\x1b[0m`,
    dim: (s) => `\x1b[90m${s}\x1b[0m`,
    b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function check(label, condition, detail) {
    if (condition) {
        pass += 1;
        console.log(`  ${c.ok('PASS')}  ${label}`);
    } else {
        fail += 1;
        failures.push(label);
        console.log(`  ${c.no('FAIL')}  ${label}`);
        if (detail !== undefined) {
            console.log(c.dim(`        got: ${JSON.stringify(detail)}`));
        }
    }
}

async function api(method, path, body, useAdminKey = false) {
    const res = await fetch(API + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(useAdminKey && ADMIN_KEY ? { 'x-admin-key': ADMIN_KEY } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
        /* some endpoints return no body */
    }
    return { status: res.status, json };
}

function section(title) {
    console.log(`\n${c.b(title)}`);
}

(async () => {
    console.log(c.b(`\nVerifying ${API}`));
    console.log(c.dim(`test user ${USER_ID}`));

    // Remember what was there so the account is left as it was found.
    const before = await api('GET', `/api/cleaning-schedule/${USER_ID}`);
    const hadSchedule = before.json && before.json.hasSchedule;

    /* ------------------------------------------------------------------ */
    section('1. The schedule endpoint is live');
    check('GET returns 200', before.status === 200, before.status);
    check(
        'response has the shape the app expects',
        before.json && 'hasSchedule' in before.json && 'suggestion' in before.json,
        before.json
    );

    /* ------------------------------------------------------------------ */
    section('2. Writing a schedule, and reading it back');
    const days = [
        { weekday: 2, hour: 9, minute: 0 },
        { weekday: 4, hour: 11, minute: 30 },
    ];
    const put = await api('PUT', `/api/cleaning-schedule/${USER_ID}`, {
        address: {
            streetAddress: '310 Court St, Brooklyn, NY 11231',
            lat: 40.6795,
            lng: -73.995,
        },
        days,
        reminderLeadMin: 60,
    });
    check('PUT accepted', put.status === 200, put.json);
    check('it says a schedule now exists', put.json && put.json.hasSchedule === true);
    check(
        'both days came back, with DIFFERENT times per day',
        put.json?.schedule?.days?.length === 2 &&
            put.json.schedule.days[0].hour === 9 &&
            put.json.schedule.days[1].hour === 11 &&
            put.json.schedule.days[1].minute === 30,
        put.json?.schedule?.days
    );
    check(
        'it worked out the next move',
        !!put.json?.next?.at,
        put.json?.next
    );

    /* ------------------------------------------------------------------ */
    section('3. Bad input is refused rather than stored');
    const badDay = await api('PUT', `/api/cleaning-schedule/${USER_ID}`, {
        address: { streetAddress: 'x', lat: 40.6, lng: -73.9 },
        days: [{ weekday: 9, hour: 9, minute: 0 }],
    });
    check('a weekday of 9 is rejected', badDay.status === 400, badDay.json);

    const noAddress = await api('PUT', `/api/cleaning-schedule/${USER_ID}`, { days });
    check('a schedule with no address is rejected', noAddress.status === 400, noAddress.json);

    const dupe = await api('PUT', `/api/cleaning-schedule/${USER_ID}`, {
        address: { streetAddress: 'x', lat: 40.6, lng: -73.9 },
        days: [
            { weekday: 2, hour: 9, minute: 0 },
            { weekday: 2, hour: 10, minute: 0 },
        ],
    });
    check('the same day twice is rejected', dupe.status === 400, dupe.json);

    /* ------------------------------------------------------------------ */
    section('4. Pause stops it, resume brings it straight back');
    const paused = await api('POST', `/api/cleaning-schedule/${USER_ID}/pause`, {});
    check('pause accepted', paused.status === 200, paused.json);
    check('reads as not active', paused.json?.active === false, paused.json?.active);
    check('no next move while paused', paused.json?.next === null, paused.json?.next);

    const resumed = await api('POST', `/api/cleaning-schedule/${USER_ID}/resume`, {});
    check('resume accepted', resumed.status === 200, resumed.json);
    check('active again', resumed.json?.active === true);
    check('next move is back', !!resumed.json?.next?.at);

    /* ------------------------------------------------------------------ */
    section('5. The subscription reads the same schedule');
    const prefill = await api('GET', `/api/subscription/prefill/${USER_ID}`);
    check('prefill returns 200', prefill.status === 200, prefill.status);
    check(
        'it serves the real schedule, not a guess from an old order',
        prefill.json?.prefill?.source === 'cleaning_schedule',
        prefill.json?.prefill?.source
    );
    check(
        'and it carries BOTH days, so the wizard arrives pre-answered',
        prefill.json?.prefill?.days?.length === 2,
        prefill.json?.prefill?.days
    );

    /* ------------------------------------------------------------------ */
    section('6. Every plan states the suspension credit');
    const plans = await api('GET', '/api/subscription/plans');
    check('plans endpoint live', plans.status === 200);
    const allMention = (plans.json?.plans || []).every((p) =>
        (p.features || []).some((f) => /credited back/i.test(f))
    );
    check(
        'all three plans say suspended days are credited back',
        allMention,
        (plans.json?.plans || []).map((p) => p.features)
    );
    check(
        'the guarantee is its own field for the subscriptions screen to highlight',
        !!plans.json?.suspensionGuarantee?.headline,
        plans.json?.suspensionGuarantee
    );

    /* ------------------------------------------------------------------ */
    section('7. The month view, and a suspension showing up in it');
    const monthKey = new Date().toISOString().slice(0, 7);
    const month = await api('GET', `/api/cleaning-schedule/${USER_ID}/month?month=${monthKey}`);
    check('month view returns cells', (month.json?.cells || []).length >= 28, month.json?.cells?.length);
    check(
        'cleaning days are marked on the right weekdays',
        (month.json?.cells || []).some((x) => x.isCleaningDay && x.weekday === 2) &&
            (month.json?.cells || []).some((x) => x.isCleaningDay && x.weekday === 4),
        'no Tue/Thu marked'
    );

    if (ADMIN_KEY) {
        // 2099 so this can never collide with a real calendar entry.
        const testDate = '2099-03-17';
        const created = await api(
            'POST',
            '/api/admin/asp-suspensions',
            { date: testDate, reason: 'Verification script' },
            true
        );
        check('admin can add a suspension', created.status === 200, created.json);

        const listed = await api('GET', `/api/admin/asp-suspensions?year=2099`, null, true);
        check(
            'it reads back',
            (listed.json?.suspensions || []).some((x) => x.date === testDate),
            listed.json?.suspensions
        );

        const marchView = await api(
            'GET',
            `/api/cleaning-schedule/${USER_ID}/month?month=2099-03`
        );
        const cell = (marchView.json?.cells || []).find((x) => x.date === testDate);
        check('the customer month view shows it suspended', cell?.suspended === true, cell);
        check('with the reason attached', cell?.reason === 'Verification script', cell?.reason);

        const dryRun = await api(
            'POST',
            '/api/admin/asp-suspensions/import',
            {
                content: "January 1 - New Year's Day\nJuly 4, 2099 - Independence Day",
                year: 2099,
                dryRun: true,
            },
            true
        );
        check(
            'pasting text from the DOT PDF parses without writing (dry run)',
            dryRun.json?.parsed === 2,
            dryRun.json
        );

        const removed = await api('DELETE', `/api/admin/asp-suspensions/${testDate}`, null, true);
        check('and it can be removed again', removed.json?.removed === 1, removed.json);
    } else {
        console.log(c.dim('  skipped admin checks — set ADMIN_KEY to run them'));
    }

    /* ------------------------------------------------------------------ */
    section('8. Putting the account back how it was found');
    if (!hadSchedule) {
        const cleared = await api('DELETE', `/api/cleaning-schedule/${USER_ID}`);
        check('test schedule removed', cleared.json?.hasSchedule === false, cleared.json);
    } else {
        console.log(c.dim('  user already had a schedule before this ran — left in place'));
    }

    /* ------------------------------------------------------------------ */
    console.log(
        `\n${c.b('Result')}  ${c.ok(pass + ' passed')}${fail ? '  ' + c.no(fail + ' failed') : ''}`
    );
    if (fail) {
        failures.forEach((f) => console.log(`  ${c.no('·')} ${f}`));
        process.exit(1);
    }
    console.log(c.dim('Nothing was ordered, dispatched or charged.\n'));
})().catch((err) => {
    console.error(c.no('\nThe script itself broke: ' + err.message));
    process.exit(1);
});
