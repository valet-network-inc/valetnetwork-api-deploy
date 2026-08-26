/**
 * The street-cleaning schedule, the NYC suspension calendar, and the credit
 * that follows a suspended day.
 *
 * The credit maths is the part worth being careful about: it moves real money,
 * it runs unattended, and the obvious implementation (a flat $12.50 a move) is
 * wrong in roughly a third of months.
 */

const { parseIcs, parseLooseText, nycDateKey } = require('../services/aspSuspensions');
const {
    scheduledMovesInPeriod,
    perMoveCents,
} = require('../services/subscriptionCredits');
const {
    nycParts,
    nycWallClockToDate,
    nextOccurrences,
    isActive,
} = require('../services/cleaningSchedule');

describe('ICS parsing (the nyc.gov annual calendar)', () => {
    const SAMPLE = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20260101',
        'SUMMARY:New Year\'s Day',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20260615',
        'SUMMARY:Eid al-Adha',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\r\n');

    it('pulls out each suspended day and its reason', () => {
        const out = parseIcs(SAMPLE);
        expect(out).toEqual([
            { date: '2026-01-01', reason: "New Year's Day" },
            { date: '2026-06-15', reason: 'Eid al-Adha' },
        ]);
    });

    it('handles RFC 5545 folded lines, which the DOT file uses', () => {
        const folded = [
            'BEGIN:VCALENDAR',
            'BEGIN:VEVENT',
            'DTSTART;VALUE=DATE:20261126',
            'SUMMARY:Thanksgiving ',
            ' Day',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        expect(parseIcs(folded)).toEqual([
            { date: '2026-11-26', reason: 'Thanksgiving Day' },
        ]);
    });

    it('returns nothing rather than throwing on junk', () => {
        expect(parseIcs('not a calendar')).toEqual([]);
        expect(parseIcs('')).toEqual([]);
        expect(parseIcs(null)).toEqual([]);
    });
});

describe('loose text parsing (copied out of the DOT PDF)', () => {
    it('reads the shapes the calendar actually uses', () => {
        const text = [
            "January 1 - New Year's Day",
            'Feb 12, 2026 — Lincoln\'s Birthday',
            '2026-05-25 Memorial Day',
            '',
            'this line has no date at all',
        ].join('\n');

        const out = parseLooseText(text, 2026);
        expect(out).toEqual([
            { date: '2026-01-01', reason: "New Year's Day" },
            { date: '2026-02-12', reason: "Lincoln's Birthday" },
            { date: '2026-05-25', reason: 'Memorial Day' },
        ]);
    });

    it('skips a line it cannot read instead of guessing a date', () => {
        expect(parseLooseText('sometime next spring, probably', 2026)).toEqual([]);
    });

    it('falls back to a generic reason rather than an empty one', () => {
        const out = parseLooseText('March 17', 2026);
        expect(out).toEqual([
            { date: '2026-03-17', reason: 'Alternate side suspended' },
        ]);
    });
});

describe('what one covered move is worth', () => {
    // August 2026: Tuesdays fall on 4, 11, 18, 25 — four of them.
    const fourMovePeriod = {
        currentPeriodStart: new Date('2026-08-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
    };
    // September 2026: Tuesdays fall on 1, 8, 15, 22, 29 — five.
    const fiveMovePeriod = {
        currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    };
    const oneTuesday = [{ weekday: 2, hour: 9, minute: 0 }];

    it('counts the moves actually scheduled in the period', () => {
        expect(
            scheduledMovesInPeriod(
                oneTuesday,
                fourMovePeriod.currentPeriodStart,
                fourMovePeriod.currentPeriodEnd
            )
        ).toBe(4);
        expect(
            scheduledMovesInPeriod(
                oneTuesday,
                fiveMovePeriod.currentPeriodStart,
                fiveMovePeriod.currentPeriodEnd
            )
        ).toBe(5);
    });

    it('is $12.50 in a four-move month — the number we quote', () => {
        const sub = {
            ...fourMovePeriod,
            amountCents: 5000,
            aspSchedule: { days: oneTuesday },
        };
        expect(perMoveCents(sub)).toBe(1250);
    });

    it('drops to $10.00 in a five-move month, instead of over-refunding', () => {
        const sub = {
            ...fiveMovePeriod,
            amountCents: 5000,
            aspSchedule: { days: oneTuesday },
        };
        expect(perMoveCents(sub)).toBe(1000);
        // The bug this test exists to prevent: a flat $12.50 would hand back
        // $62.50 against a $50 month.
        expect(perMoveCents(sub) * 5).toBeLessThanOrEqual(sub.amountCents);
    });

    it('never refunds more than the customer paid, on any plan shape', () => {
        const twoDays = [
            { weekday: 2, hour: 9, minute: 0 },
            { weekday: 4, hour: 9, minute: 0 },
        ];
        const sub = {
            ...fiveMovePeriod,
            amountCents: 10000,
            aspSchedule: { days: twoDays },
        };
        const moves = scheduledMovesInPeriod(
            twoDays,
            sub.currentPeriodStart,
            sub.currentPeriodEnd
        );
        expect(perMoveCents(sub) * moves).toBeLessThanOrEqual(sub.amountCents + moves);
    });

    it('returns 0 rather than dividing by zero when there is no schedule', () => {
        expect(perMoveCents({ ...fourMovePeriod, amountCents: 5000, aspSchedule: { days: [] } })).toBe(0);
        expect(perMoveCents({ amountCents: 5000, aspSchedule: { days: [{ weekday: 2 }] } })).toBe(0);
    });

    it('prefers the resolved user schedule over the subscription copy', () => {
        const sub = {
            ...fourMovePeriod,
            amountCents: 10000,
            aspSchedule: { days: oneTuesday },
            _resolvedSchedule: {
                days: [
                    { weekday: 2, hour: 9, minute: 0 },
                    { weekday: 4, hour: 9, minute: 0 },
                ],
            },
        };
        // 4 Tuesdays + 4 Thursdays in August 2026 = 8 moves, $100/8 = $12.50
        expect(perMoveCents(sub)).toBe(1250);
    });
});

describe('New York time handling', () => {
    it('reads a weekday in New York, not UTC', () => {
        // 00:30 UTC on a Tuesday is still Monday evening in New York.
        const instant = new Date('2026-08-18T00:30:00Z');
        expect(nycParts(instant).weekday).toBe(1); // Monday
    });

    it('round-trips a wall-clock time through daylight saving', () => {
        const summer = nycWallClockToDate('2026-08-18', 9, 0);
        expect(nycParts(summer).hour).toBe(9);
        const winter = nycWallClockToDate('2026-01-13', 9, 0);
        expect(nycParts(winter).hour).toBe(9);
    });

    it('formats a date key in New York', () => {
        expect(nycDateKey(new Date('2026-08-18T03:00:00Z'))).toBe('2026-08-17');
    });
});

describe('upcoming occurrences', () => {
    const schedule = {
        days: [
            { weekday: 2, hour: 9, minute: 0 },
            { weekday: 4, hour: 9, minute: 0 },
        ],
    };

    it('returns the next few, in order, all in the future', () => {
        const from = new Date('2026-08-17T12:00:00Z'); // a Monday
        const out = nextOccurrences(schedule, 4, from);
        expect(out).toHaveLength(4);
        out.forEach((o) => expect(o.at.getTime()).toBeGreaterThan(from.getTime()));
        for (let i = 1; i < out.length; i += 1) {
            expect(out[i].at.getTime()).toBeGreaterThan(out[i - 1].at.getTime());
        }
        expect(nycParts(out[0].at).weekday).toBe(2);
        expect(nycParts(out[1].at).weekday).toBe(4);
    });

    it('gives nothing for an empty schedule instead of looping', () => {
        expect(nextOccurrences({ days: [] }, 4)).toEqual([]);
        expect(nextOccurrences(null, 4)).toEqual([]);
    });
});

describe('pausing', () => {
    const days = [{ weekday: 2, hour: 9, minute: 0 }];

    it('is active when running', () => {
        expect(isActive({ days, status: 'active' })).toBe(true);
    });

    it('is not active while paused indefinitely', () => {
        expect(isActive({ days, status: 'paused', pausedUntil: null })).toBe(false);
    });

    it('comes back on its own once a dated pause lapses', () => {
        const now = new Date('2026-08-20T12:00:00Z');
        expect(
            isActive({ days, status: 'paused', pausedUntil: new Date('2026-08-19T00:00:00Z') }, now)
        ).toBe(true);
        expect(
            isActive({ days, status: 'paused', pausedUntil: new Date('2026-08-25T00:00:00Z') }, now)
        ).toBe(false);
    });

    it('is never active without days', () => {
        expect(isActive({ days: [], status: 'active' })).toBe(false);
    });
});

/* -------------------------------------------------------------------------- */
/* What the operator console reads off a schedule                              */
/* -------------------------------------------------------------------------- */

const {
    describe: describeSchedule,
    describeShort,
    clockLabel,
    summarize,
} = require('../services/cleaningSchedule');

describe('putting a schedule into words', () => {
    it('writes one day as a sentence', () => {
        expect(describeSchedule({ days: [{ weekday: 2, hour: 11, minute: 30 }] }))
            .toBe('Tuesdays at 11:30 AM');
    });

    it('keeps each day on its own time — signs differ between a block\'s two days', () => {
        const schedule = { days: [{ weekday: 4, hour: 9, minute: 0 }, { weekday: 2, hour: 11, minute: 30 }] };
        expect(describeSchedule(schedule)).toBe('Tuesdays at 11:30 AM and Thursdays at 9:00 AM');
        // Sunday-first order, whatever order they were stored in.
        expect(describeShort(schedule)).toBe('Tue 11:30 AM · Thu 9:00 AM');
    });

    it('reads noon and midnight the way a person says them', () => {
        expect(clockLabel(12, 0)).toBe('12:00 PM');
        expect(clockLabel(0, 5)).toBe('12:05 AM');
        expect(clockLabel(13, 45)).toBe('1:45 PM');
    });

    it('says nothing rather than something wrong when no days are set', () => {
        expect(describeSchedule({ days: [] })).toBeNull();
        expect(describeShort(null)).toBeNull();
    });
});

describe('summarising a schedule for a list view', () => {
    // A Wednesday, 8am in New York.
    const FROM = new Date('2026-08-26T12:00:00Z');
    const TUESDAYS = { days: [{ weekday: 2, hour: 11, minute: 30 }], status: 'active' };

    it('reports the next move and the ones after it', () => {
        const out = summarize(TUESDAYS, { from: FROM });
        expect(out.hasSchedule).toBe(true);
        expect(out.active).toBe(true);
        expect(out.shortLabel).toBe('Tue 11:30 AM');
        expect(out.daysPerWeek).toBe(1);
        expect(out.next.dateKey).toBe('2026-09-01');
        expect(out.upcoming.map((u) => u.dateKey))
            .toEqual(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']);
    });

    it('marks a suspended day rather than hiding it, and skips it for "next"', () => {
        const suspendedByDate = new Map([['2026-09-01', { date: '2026-09-01', reason: 'Labor Day' }]]);
        const out = summarize(TUESDAYS, { from: FROM, suspendedByDate });
        // The suspended day still shows on the calendar...
        expect(out.upcoming[0]).toMatchObject({ dateKey: '2026-09-01', suspended: true, reason: 'Labor Day' });
        // ...but nobody is being moved that day.
        expect(out.next.dateKey).toBe('2026-09-08');
    });

    it('calls a paused schedule paused, and a lapsed pause active again', () => {
        const paused = { ...TUESDAYS, status: 'paused', pausedUntil: new Date('2026-09-30T00:00:00Z') };
        expect(summarize(paused, { from: FROM }).active).toBe(false);
        expect(summarize(paused, { from: FROM }).status).toBe('paused');

        const lapsed = { ...TUESDAYS, status: 'paused', pausedUntil: new Date('2026-08-01T00:00:00Z') };
        expect(summarize(lapsed, { from: FROM }).active).toBe(true);
    });

    it('returns the empty shape, not a crash, for a customer who never set one', () => {
        expect(summarize(null, { from: FROM })).toMatchObject({ hasSchedule: false, next: null, upcoming: [] });
        expect(summarize({ days: [] }, { from: FROM }).hasSchedule).toBe(false);
    });
});
