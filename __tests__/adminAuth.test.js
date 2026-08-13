/**
 * Every /api/admin route must require the x-admin-key header.
 *
 * Before this, only /admin/notifications/* was gated: an unauthenticated GET of
 * /api/admin/users returned all 65 customers with names and phone numbers. This
 * test walks the mounted router and asserts that no route answers without the
 * key, so a future route added to routes/admin.js cannot quietly reopen it.
 */

const express = require('express');
const request = require('supertest');

const ADMIN_KEY = 'test-admin-key';

// The controllers pull in mongoose models; none of them run here because the
// gate rejects before any handler is reached.
const adminRouter = require('../routes/admin');

const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    return app;
};

// Pull the real path list off the router so this stays honest as routes change.
const mountedRoutes = adminRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
        path: layer.route.path,
        method: Object.keys(layer.route.methods)[0],
    }));

// Route params are irrelevant to the gate — any placeholder reaches the same
// middleware.
const concretePath = (p) => `/api/admin${p.replace(/:[^/]+/g, 'placeholder')}`;

describe('/api/admin auth', () => {
    const originalKey = process.env.ADMIN_API_KEY;

    beforeEach(() => {
        process.env.ADMIN_API_KEY = ADMIN_KEY;
    });

    afterAll(() => {
        if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = originalKey;
    });

    it('mounts the routes the dashboard calls', () => {
        const paths = mountedRoutes.map((r) => r.path);
        expect(paths).toEqual(
            expect.arrayContaining([
                '/users',
                '/valets',
                '/metrics/business',
                '/payouts',
                '/parking-photos',
                '/notifications/send',
            ])
        );
    });

    it.each(mountedRoutes)('rejects $method $path with no key', async ({ path, method }) => {
        const res = await request(buildApp())[method](concretePath(path));
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it.each(mountedRoutes)('rejects $method $path with a wrong key', async ({ path, method }) => {
        const res = await request(buildApp())
            [method](concretePath(path))
            .set('x-admin-key', 'not-the-key');
        expect(res.status).toBe(401);
    });

    it('lets the right key through', async () => {
        const res = await request(buildApp())
            .get('/api/admin/session')
            .set('x-admin-key', ADMIN_KEY);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('fails closed with 503 when the server has no key configured', async () => {
        delete process.env.ADMIN_API_KEY;
        const res = await request(buildApp())
            .get('/api/admin/users')
            .set('x-admin-key', ADMIN_KEY);
        expect(res.status).toBe(503);
    });
});
