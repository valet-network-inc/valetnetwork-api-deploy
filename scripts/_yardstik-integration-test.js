/**
 * Internal: HTTP integration test for the Yardstik provider path.
 * Walks initiate → DB → webhook → DB → resend → status, plus edge cases.
 * Reusable: delete after each run or keep around for paranoia checks.
 *
 * Usage: requires the dev backend running on port 3099 with
 *   BACKGROUND_CHECK_PROVIDER=yardstik. Connects to dev MongoDB and creates
 *   a throwaway test User, cleans it up at the end.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.development') });
const mongoose = require('mongoose');
const axios = require('axios');
const User = require('../models/User');

const BASE = 'http://localhost:3099';

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('[setup] connected to MongoDB');

    const testUser = await User.create({
        phone: `+1555${Date.now().toString().slice(-7)}`,
        verified: true,
        firstName: 'Yardstik',
        lastName: 'IntegrationTest',
        age: 28,
        isValet: true,
    });
    console.log(`[setup] created test valet User _id=${testUser._id}`);

    try {
        console.log('\n[1] POST /initiateBackgroundCheck');
        const initRes = await axios.post(`${BASE}/api/valet/initiateBackgroundCheck`, {
            userId: testUser._id.toString(),
            firstName: 'Yardstik',
            lastName: 'IntegrationTest',
            email: `rishi.ganesh0305+integ-${Date.now()}@gmail.com`,
        });
        if (!initRes.data.success) throw new Error('initiate failed');
        if (initRes.data.provider !== 'yardstik') throw new Error('wrong provider');
        if (!initRes.data.applicationId) throw new Error('no applicationId');
        if (!initRes.data.applyUrl) throw new Error('no applyUrl');
        console.log('  ✓ initiate response shape correct');

        let u = await User.findById(testUser._id);
        if (u.backgroundCheck.status !== 'pending') throw new Error('DB: expected status=pending');
        if (u.backgroundCheck.provider !== 'yardstik') throw new Error('DB: expected provider=yardstik');
        if (!u.backgroundCheck.certnApplicationId) throw new Error('DB: missing certnApplicationId');
        if (!u.backgroundCheck.invitationId) throw new Error('DB: missing invitationId');
        if (!u.backgroundCheck.initiatedAt) throw new Error('DB: missing initiatedAt');
        console.log('  ✓ DB updated correctly');

        const reportId = u.backgroundCheck.certnApplicationId;

        console.log('\n[2] POST /api/webhooks/yardstik (synthetic clear)');
        await axios.post(`${BASE}/api/webhooks/yardstik`, {
            data: {
                id: `evt_${Date.now()}`,
                resource_type: 'report',
                resource_id: reportId,
                status: 'clear',
                candidate: { external_id: testUser._id.toString() },
            },
        });
        u = await User.findById(testUser._id);
        if (u.backgroundCheck.status !== 'passed') throw new Error('webhook: expected status=passed');
        if (u.backgroundCheck.certnResult !== 'clear') throw new Error('webhook: expected certnResult=clear');
        if (!u.backgroundCheck.completedAt) throw new Error('webhook: missing completedAt');
        console.log('  ✓ clear webhook transitioned DB correctly');

        console.log('\n[3] reset to pending, POST /resendBackgroundCheckInvitation');
        await User.updateOne({ _id: testUser._id }, { 'backgroundCheck.status': 'pending' });
        const resendRes = await axios.post(`${BASE}/api/valet/resendBackgroundCheckInvitation`, {
            userId: testUser._id.toString(),
        });
        if (!resendRes.data.success) throw new Error('resend failed');
        if (resendRes.data.refreshed !== false) throw new Error('expected refreshed=false for active invitation');
        if (!resendRes.data.applyUrl) throw new Error('resend: no applyUrl');
        console.log('  ✓ resend correctly returned existing applyUrl with refreshed=false');

        console.log('\n[4] GET /backgroundCheckStatus');
        const statusRes = await axios.get(`${BASE}/api/valet/backgroundCheckStatus`, {
            params: { userId: testUser._id.toString() },
        });
        if (!statusRes.data.success) throw new Error('status fetch failed');
        if (!statusRes.data.backgroundCheck) throw new Error('status: no backgroundCheck object');
        console.log('  ✓ status endpoint returns full object');

        console.log('\n[5] edge: non-terminal webhook (queued) does NOT mutate DB');
        const before = (await User.findById(testUser._id)).backgroundCheck.status;
        await axios.post(`${BASE}/api/webhooks/yardstik`, {
            data: {
                id: `evt_${Date.now()}`,
                resource_type: 'report',
                resource_id: reportId,
                status: 'queued',
                candidate: { external_id: testUser._id.toString() },
            },
        });
        const after = (await User.findById(testUser._id)).backgroundCheck.status;
        if (before !== after) throw new Error(`queued mutated DB: ${before} -> ${after}`);
        console.log('  ✓ non-terminal correctly ignored');

        console.log('\n[6] edge: webhook for unknown user acks 200, no crash');
        const unknownRes = await axios.post(`${BASE}/api/webhooks/yardstik`, {
            data: {
                id: 'fake-report-xyz',
                status: 'clear',
                candidate: { external_id: '000000000000000000000000' },
            },
        });
        if (unknownRes.status !== 200) throw new Error(`expected 200 on unknown user, got ${unknownRes.status}`);
        console.log('  ✓ unknown user acked 200');

        console.log('\n[7] edge: invalid userId on /initiate → 400');
        try {
            await axios.post(`${BASE}/api/valet/initiateBackgroundCheck`, {});
            throw new Error('expected 400 on empty body');
        } catch (e) {
            if (e.response?.status !== 400) throw new Error(`expected 400, got ${e.response?.status}`);
        }
        console.log('  ✓ empty body rejected with 400');

        console.log('\n[8] edge: status=passed → /initiate returns 400');
        await User.updateOne({ _id: testUser._id }, { 'backgroundCheck.status': 'passed' });
        try {
            await axios.post(`${BASE}/api/valet/initiateBackgroundCheck`, {
                userId: testUser._id.toString(),
                firstName: 'X', lastName: 'X', email: 'x@x.x',
            });
            throw new Error('expected 400 on status=passed');
        } catch (e) {
            if (e.response?.status !== 400) throw new Error(`expected 400, got ${e.response?.status}`);
        }
        console.log('  ✓ already-passed user blocked from re-initiating');

        console.log('\n✅ ALL CHECKS PASSED');
    } finally {
        await User.deleteOne({ _id: testUser._id });
        console.log(`\n[cleanup] deleted test User _id=${testUser._id}`);
        await mongoose.disconnect();
    }
}

main().catch((e) => {
    console.error('\n❌ FAILED:', e.response?.data || e.message);
    console.error(e.stack);
    process.exit(1);
});
