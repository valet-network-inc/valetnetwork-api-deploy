/**
 * The commission agreement a rep signs before the portal opens (spec v2, 17).
 *
 * The text is stored versioned in Mongo. config/commissionAgreement.md is
 * the source: when it differs from the latest stored version, it is stored as
 * the next version, so editing the file and deploying publishes it, and every
 * rep signs again before the portal reopens. A rep's signature is the full
 * name they type plus today's date in New York, recorded with the version.
 * On signing, a PDF of the agreement as signed is emailed to the rep, cc
 * Rishi, from rishi@valetnetwork.co. The email needs SMTP settings:
 *
 *   SMTP_HOST      smtp.gmail.com (valetnetwork.co mail is Google Workspace)
 *   SMTP_PORT      465
 *   SMTP_USER      rishi@valetnetwork.co
 *   SMTP_PASS      a Google app password for that account
 *   MAIL_FROM      optional, default "Rishi Ganesh <rishi@valetnetwork.co>"
 *   AGREEMENT_CC   optional, default rishi@valetnetwork.co
 *
 * Without them signing still works: the email is recorded as not_configured
 * and the signed PDF is downloadable from the portal.
 */
const fs = require('fs');
const path = require('path');
const RepAgreement = require('../models/RepAgreement');

const SEED_TEXT = fs.readFileSync(path.join(__dirname, '..', 'config', 'commissionAgreement.md'), 'utf8');
const CC_DEFAULT = 'rishi@valetnetwork.co';
const FROM_DEFAULT = 'Rishi Ganesh <rishi@valetnetwork.co>';

let cached = null;

/** The current version: { version, text }. Publishes the file's text as the next version when it changed. */
async function current() {
    if (cached && Date.now() - cached.at < 60 * 1000) return cached.doc;
    let doc = await RepAgreement.findOne({}).sort({ version: -1 }).lean();
    if (!doc || doc.text !== SEED_TEXT) {
        const version = doc ? doc.version + 1 : 1;
        try {
            doc = (await RepAgreement.create({ version, text: SEED_TEXT })).toObject();
        } catch (err) {
            // Another process published it a moment ago.
            if (err && err.code === 11000) doc = await RepAgreement.findOne({}).sort({ version: -1 }).lean();
            else throw err;
        }
    }
    cached = { at: Date.now(), doc };
    return doc;
}

function invalidate() {
    cached = null;
}

/** "October 9, 2026" in New York. */
function longDate(date) {
    return new Date(date).toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
}

/** "2026-10-09" in New York. */
function isoDay(date) {
    return new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The stored text as the portal shows it, with the rep's name and the date
 * filled in: { title, subtitle, draft, intro, sections: [{heading, body}], note }.
 */
function parse(text, { name, phone, email, date }) {
    const { formatPhone } = require('./phoneCodes');
    const filled = text
        .replace(/\{REP_NAME\}/g, name || 'the Rep')
        .replace(/\{REP_PHONE\}/g, phone ? formatPhone(phone) : '[phone]')
        .replace(/\{REP_EMAIL\}/g, email || '[email]')
        .replace(/\{START_DATE\}/g, longDate(date));
    const blocks = filled.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const out = { title: '', subtitle: '', draft: '', intro: '', sections: [], note: '' };
    const intro = [];
    let section = null;
    for (const b of blocks) {
        if (b.startsWith('# ')) out.title = b.slice(2).trim();
        else if (b.startsWith('## ')) {
            section = { heading: b.slice(3).trim(), body: '' };
            out.sections.push(section);
        } else if (/^DRAFT\b/.test(b)) out.draft = b;
        else if (!out.subtitle && !section && !intro.length && out.title) out.subtitle = b;
        else if (/^This is a draft for review/.test(b)) out.note = b;
        else if (section) section.body = section.body ? `${section.body}\n\n${b}` : b;
        else intro.push(b);
    }
    out.intro = intro.join('\n\n');
    return out;
}

/** What GET /api/rep/agreement returns for this rep. */
async function viewFor(rep, now = new Date()) {
    const doc = await current();
    const signed = isSigned(rep, doc);
    const date = signed ? rep.agreement.signedAt : now;
    return { version: doc.version, ...parse(doc.text, { name: rep.name, phone: rep.phone, email: rep.email, date }) };
}

function isSigned(rep, doc) {
    return !!(rep && rep.agreement && rep.agreement.signedAt && doc && rep.agreement.version === doc.version);
}

async function isSignedNow(rep) {
    return isSigned(rep, await current());
}

/** The status block /me carries. */
async function statusFor(rep) {
    const doc = await current();
    const a = rep.agreement || {};
    return {
        signed: isSigned(rep, doc),
        version: doc.version,
        signedAt: a.signedAt || null,
        signedName: a.signedName || null,
        sentTo: a.sentTo || [],
        emailStatus: a.emailStatus || null,
    };
}

/** A PDF of the agreement as signed. Resolves to a Buffer. */
async function pdfFor(rep) {
    const doc = await current();
    const PDFDocument = require('pdfkit');
    const signed = isSigned(rep, doc);
    const a = parse(doc.text, { name: rep.name, phone: rep.phone, email: rep.email, date: signed ? rep.agreement.signedAt : new Date() });
    const pdf = new PDFDocument({ size: 'LETTER', margins: { top: 60, bottom: 60, left: 64, right: 64 } });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
        pdf.on('data', (c) => chunks.push(c));
        pdf.on('end', () => resolve(Buffer.concat(chunks)));
        pdf.on('error', reject);
    });
    const ink = '#123524';
    pdf.fillColor(ink).font('Helvetica-Bold').fontSize(20).text(a.title);
    pdf.moveDown(0.3).font('Helvetica').fontSize(11).text(a.subtitle);
    if (a.draft) pdf.moveDown(0.6).font('Helvetica-Bold').fontSize(9).text(a.draft);
    pdf.moveDown(0.8).font('Helvetica').fontSize(10.5);
    for (const p of a.intro.split('\n\n')) pdf.text(p, { lineGap: 2 }).moveDown(0.6);
    for (const s of a.sections) {
        pdf.moveDown(0.4).font('Helvetica-Bold').fontSize(12).text(s.heading).moveDown(0.3);
        pdf.font('Helvetica').fontSize(10.5);
        for (const block of s.body.split('\n\n')) {
            for (const line of block.split('\n')) {
                if (line.startsWith('- ')) pdf.text(`•  ${line.slice(2)}`, { indent: 10, lineGap: 2 });
                else pdf.text(line, { lineGap: 2 });
            }
            pdf.moveDown(0.5);
        }
    }
    if (a.note) pdf.moveDown(0.4).font('Helvetica-Oblique').fontSize(9).text(a.note);
    if (signed) {
        pdf.moveDown(1.2).font('Helvetica-Bold').fontSize(12).text('Signed');
        pdf.moveDown(0.3).font('Helvetica').fontSize(10.5);
        pdf.text(`Valet Network, Inc.: Rishi Ganesh`);
        pdf.text(`The Rep: ${rep.agreement.signedName}`);
        pdf.text(`Date: ${longDate(rep.agreement.signedAt)}`);
        pdf.text(`Signed electronically by the Rep typing their full name in the rep portal. Agreement version ${rep.agreement.version}.`);
    } else {
        pdf.moveDown(1.2).font('Helvetica-Bold').fontSize(12).text('Not signed yet');
        pdf.font('Helvetica').fontSize(10.5);
    }
    pdf.moveDown(0.6).text('Valet Network, Inc. · 21-31 24th Street, Astoria, NY 11105 · rishi@valetnetwork.co');
    pdf.end();
    return done;
}

function pdfFilename(rep) {
    const at = rep.agreement && rep.agreement.signedAt;
    return at ? `Commission agreement · ${rep.name} · ${isoDay(at)}.pdf` : 'Commission agreement (draft).pdf';
}

/** Email the signed copy. Returns { status, sentTo, error? }. Never throws. */
async function emailSigned(rep, pdf) {
    const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return { status: 'not_configured', sentTo: [] };
    const cc = process.env.AGREEMENT_CC || CC_DEFAULT;
    const to = rep.email ? [rep.email] : [];
    try {
        const nodemailer = require('nodemailer');
        const port = Number(process.env.SMTP_PORT || 465);
        const transport = nodemailer.createTransport({
            host: SMTP_HOST,
            port,
            secure: port === 465,
            auth: { user: SMTP_USER, pass: SMTP_PASS },
            connectionTimeout: 15000,
        });
        const first = String(rep.name || '').split(/\s+/)[0] || 'Hi';
        await transport.sendMail({
            from: process.env.MAIL_FROM || FROM_DEFAULT,
            to: to.length ? `${rep.name} <${rep.email}>` : cc,
            ...(to.length ? { cc } : {}),
            subject: `Signed: Valet Network commission agreement · ${rep.name}`,
            text:
                `${first},\n\n` +
                `Your signed commission agreement with Valet Network is attached. You signed it as ` +
                `${rep.agreement.signedName} on ${longDate(rep.agreement.signedAt)}.\n\n` +
                `Your portal is at valetnetwork.co/rep.\n\nRishi\n`,
            attachments: [{ filename: pdfFilename(rep), content: pdf, contentType: 'application/pdf' }],
        });
        return { status: 'sent', sentTo: [...to, cc] };
    } catch (err) {
        console.error('repAgreement: email failed:', err.message);
        return { status: 'failed', sentTo: [], error: err.message };
    }
}

/**
 * Sign the current version. Returns { signedName, signedAt, sentTo, emailStatus }
 * or { status, error }.
 */
async function sign(rep, { fullName, version, ip, userAgent } = {}, now = new Date()) {
    const doc = await current();
    if (Number(version) !== doc.version) {
        return { status: 409, error: 'The agreement changed. Read the new version and sign again.' };
    }
    const name = String(fullName || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2) return { status: 400, error: 'Type your full name.' };
    if (!isSigned(rep, doc)) {
        rep.agreement = { version: doc.version, signedName: name, signedAt: now, ip, userAgent };
        await rep.save();
        const pdf = await pdfFor(rep);
        const mail = await emailSigned(rep, pdf);
        rep.agreement.emailStatus = mail.status;
        rep.agreement.sentTo = mail.sentTo;
        if (mail.error) rep.agreement.emailError = mail.error;
        await rep.save();
    }
    return {
        signedName: rep.agreement.signedName,
        signedAt: rep.agreement.signedAt,
        sentTo: rep.agreement.sentTo || [],
        emailStatus: rep.agreement.emailStatus || null,
    };
}

module.exports = { current, invalidate, parse, viewFor, isSigned, isSignedNow, statusFor, sign, pdfFor, pdfFilename, longDate };
