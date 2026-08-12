/**
 * Yardstik sandbox walkthrough — Phase 0 of the Certn → Yardstik migration.
 *
 * Runs the full invitation-flow end-to-end against staging so we can inspect
 * the live payload shapes before writing any production code.
 *
 * Usage:
 *   YARDSTIK_TEST_EMAIL=you+yardstik1@example.com node scripts/yardstik-sandbox.js
 *
 * Sandbox SSNs to enter on Yardstik's hosted form (after clicking the email link):
 *   111-22-3333  → clear
 *   333-22-1111  → consider (criminal record found)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.development') });

const API_KEY = process.env.YARDSTIK_API_KEY;
const BASE_URL = process.env.YARDSTIK_BASE_URL || 'https://api.yardstik-staging.com';
const PACKAGE_SYSTEM_NAME = process.env.YARDSTIK_PACKAGE_SYSTEM_NAME || 'idv_premium_mvr';
const EMAIL = process.env.YARDSTIK_TEST_EMAIL;
const FIRST_NAME = process.env.YARDSTIK_TEST_FIRST_NAME || 'Rishi';
const LAST_NAME = process.env.YARDSTIK_TEST_LAST_NAME || 'TestCandidate';
const POLL_INTERVAL_MS = 15000;

if (!API_KEY) die('YARDSTIK_API_KEY not set in .env.development');
if (!EMAIL) die('YARDSTIK_TEST_EMAIL not set — pass via env, e.g.\n    YARDSTIK_TEST_EMAIL=you+test@gmail.com node scripts/yardstik-sandbox.js');

const TERMINAL_STATUSES = new Set([
  'clear', 'consider', 'pass', 'fail', 'proceed',
  'final_adverse', 'canceled', 'expired',
]);

function die(msg) { console.error(`\nERROR: ${msg}\n`); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: {
      'Authorization': `Account ${API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    console.error(`\nAPI ${method} ${urlPath} failed: HTTP ${res.status}`);
    console.error(parsed);
    process.exit(1);
  }
  return parsed;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Yardstik sandbox walkthrough');
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   Package:  ${PACKAGE_SYSTEM_NAME}`);
  console.log(`   Candidate: ${FIRST_NAME} ${LAST_NAME} <${EMAIL}>`);
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('[1/4] Listing packages…');
  const packages = await api('GET', '/packages');
  const pkg = packages.find(p => p.package_system_name === PACKAGE_SYSTEM_NAME);
  if (!pkg) {
    console.error(`Package "${PACKAGE_SYSTEM_NAME}" not found. Available:`);
    packages.forEach(p => console.error(`  - ${p.package_system_name} (${p.name})`));
    process.exit(1);
  }
  console.log(`      Account: ${pkg.account.account_name}`);
  console.log(`      account_package_id = ${pkg.id}`);
  console.log(`      name = ${pkg.name}\n`);

  console.log('[2/4] Creating candidate…');
  const candidate = await api('POST', '/candidates', {
    first_name: FIRST_NAME,
    last_name: LAST_NAME,
    email: EMAIL,
  });
  console.log(`      candidate.id = ${candidate.id}\n`);

  console.log('[3/4] Creating invitation (Yardstik will email candidate)…');
  const invitation = await api('POST', '/invitations', {
    account_package_id: pkg.id,
    candidate_id: candidate.id,
  });
  const reportId = invitation.report && invitation.report.id;
  console.log(`      invitation.id      = ${invitation.id}`);
  console.log(`      confirmation_code  = ${invitation.confirmation_code}`);
  console.log(`      expires_at         = ${invitation.expires_at}`);
  console.log(`      report.id          = ${reportId}`);
  if (invitation.report_urls && invitation.report_urls.length) {
    console.log(`      direct form URL(s):`);
    invitation.report_urls.forEach(u => console.log(`        ${u}`));
  }
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Check inbox: ${EMAIL}`);
  console.log(' Open the Yardstik link and complete the form.');
  console.log(' Sandbox SSNs:');
  console.log('   111-22-3333  → clear');
  console.log('   333-22-1111  → consider');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!reportId) die('No report.id returned on invitation — cannot poll.');

  console.log(`[4/4] Polling /reports/${reportId} every ${POLL_INTERVAL_MS/1000}s…\n`);
  let lastStatus = null;
  for (;;) {
    let report;
    try {
      report = await api('GET', `/reports/${reportId}`);
    } catch (e) {
      console.error(`  [${ts()}] poll error, retrying: ${e.message}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const status = report.status || 'unknown';
    if (status !== lastStatus) {
      console.log(`  [${ts()}] status: ${lastStatus || '—'} → ${status}`);
      lastStatus = status;
    } else {
      console.log(`  [${ts()}] still ${status}`);
    }
    if (TERMINAL_STATUSES.has(status) || report.completed_at) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log(' Report reached terminal state. Full payload:');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
