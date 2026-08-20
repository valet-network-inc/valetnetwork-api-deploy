const express = require('express');
const connectDB = require('./db');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const admin = require('firebase-admin');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
connectDB();

// Initialize Firebase Admin SDK
try {
    // Prefer the credential supplied by the environment. The firebase-admin.json
    // checked into this repo is the DEV project (valet-nyc-dev) — booting a
    // production host off it points every push notification at the wrong
    // project, which fails silently: sends "succeed" and no device is notified.
    const serviceAccountPath = path.join(__dirname, 'firebase-admin.json');
    const inlineServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (inlineServiceAccount) {
        const serviceAccount = JSON.parse(inlineServiceAccount);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: serviceAccount.project_id,
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`,
        });
        console.log('Firebase Admin SDK initialized from FIREBASE_SERVICE_ACCOUNT_JSON with project:', serviceAccount.project_id);
    } else if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = require('./firebase-admin.json');
        console.warn(`No FIREBASE_SERVICE_ACCOUNT_JSON set — falling back to the bundled key for project "${serviceAccount.project_id}".`);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: serviceAccount.project_id,
            // Storage bucket for valet document uploads (DL photos, etc.).
            // Pulled from env so dev/prod can point at different buckets.
            // Falls back to the default `<project>.firebasestorage.app` if unset.
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`,
        });
        console.log('Firebase Admin SDK initialized successfully with project:', serviceAccount.project_id);
    } else {
        console.warn('Firebase service account file not found. Push notifications will be unavailable.');
    }
} catch (error) {
    console.warn('Failed to initialize Firebase Admin SDK:', error.message);
}

const app = express();
const server = http.createServer(app);
// socket.io matches these as exact strings — a '*' entry in the array is not a
// wildcard, it is an origin literally named "*". The old list therefore allowed
// only the two dev hosts, so live order updates never reached any production
// browser. Native apps send no Origin header and were unaffected.
const SOCKET_ORIGINS = (process.env.SOCKET_CORS_ORIGINS
    ? process.env.SOCKET_CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [
        'https://valetnetwork.co',
        'https://www.valetnetwork.co',
        'https://admin.valetnetwork.co',
        'https://valetnyc-39ecd.web.app',
        'https://valetnyc-39ecd.firebaseapp.com',
        'https://valet-nyc-dev.web.app',
        'https://valet-nyc-dev.firebaseapp.com',
        'http://localhost:3000',
    ]);

const io = socketIo(server, {
    cors: {
        origin: SOCKET_ORIGINS,
        methods: ['GET', 'POST'],
    },
});

// Stripe webhook needs raw body for signature verification - MUST be FIRST before any other middleware
app.use('/api/payment/webhook', bodyParser.raw({ type: 'application/json' }));

// Yardstik webhook also needs the raw request body for HMAC-SHA256 signature
// verification, but still wants JSON parsed into req.body for the handler.
// Mounting before global bodyParser.json so this route uses the verify-capable
// parser; the global parser will then no-op for this route.
app.use('/api/webhooks/yardstik', bodyParser.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use((req, res, next) => {
    req.io = io;
    next();
});

app.use(bodyParser.json());
app.use(cors());

// API Logging Middleware
app.use((req, res, next) => {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    
    // Log request
    // console.log(`[${timestamp}] ${req.method} ${req.originalUrl} - Request started`);
    // console.log(`[${timestamp}] Request Body:`, req.body);
    // console.log(`[${timestamp}] Request Headers:`, {
    //     'content-type': req.headers['content-type'],
    //     'authorization': req.headers.authorization ? 'Bearer [REDACTED]' : 'None',
    //     'user-agent': req.headers['user-agent']
    // });
    
    // Override res.json to log response
    const originalJson = res.json;
    res.json = function(data) {
        const duration = Date.now() - start;
        const responseTimestamp = new Date().toISOString();
        
        console.log(`[${responseTimestamp}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
        // console.log(`[${responseTimestamp}] Response Body:`, data);
        // console.log('---');
        
        return originalJson.call(this, data);
    };
    
    // Override res.status to log status changes
    const originalStatus = res.status;
    res.status = function(code) {
        const statusTimestamp = new Date().toISOString();
        // console.log(`[${statusTimestamp}] ${req.method} ${req.originalUrl} - Status set to: ${code}`);
        return originalStatus.call(this, code);
    };
    
    next();
});

// Swagger UI Documentation. Mounted best-effort: docs are not worth taking the
// whole API down for, and an unguarded readFileSync here crashed before listen()
// whenever the yaml did not make it into a deploy.
const mountSwagger = (route, ...segments) => {
    try {
        const specPath = path.join(__dirname, ...segments);
        const spec = yaml.parse(fs.readFileSync(specPath, 'utf8'));
        app.use(route, swaggerUi.serveFiles(spec), swaggerUi.setup(spec));
    } catch (err) {
        console.warn(`Swagger docs unavailable at ${route}: ${err.message}`);
    }
};

mountSwagger('/api-docs', 'swagger.yaml');
mountSwagger('/admin-api-docs', 'swagger', 'admin.yaml');

// Liveness probe for the host's health check. Reports the Mongo connection
// state so a box that is listening but has no database reads as unhealthy
// rather than quietly serving errors.
app.get('/health', (req, res) => {
    const mongoose = require('mongoose');
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({
        status: dbUp ? 'ok' : 'degraded',
        db: dbUp ? 'connected' : 'disconnected',
        uptimeSeconds: Math.round(process.uptime()),
    });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/order', require('./routes/order'));
app.use('/api/pricing', require('./routes/pricing'));
app.use('/api/chauffeur', require('./routes/chauffeur'));
app.use('/api/parking-notes', require('./routes/parkingNote'));
app.use('/api/saved-customers', require('./routes/savedCustomer'));
app.use('/api/street-parking', require('./routes/streetParking'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/notification', require('./routes/notification'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/cleaning-schedule', require('./routes/cleaningSchedule'));
app.use('/api/event', require('./routes/eventRoutes'));
app.use('/api/key-transfer', require('./routes/keyTransfer'));
app.use('/api/location', require('./routes/location'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/valet', require('./routes/valet'));
app.use('/api/webhooks', require('./routes/webhook'));

// Error Logging Middleware
app.use((err, req, res, next) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR in ${req.method} ${req.originalUrl}:`, {
        message: err.message,
        stack: err.stack,
        body: req.body,
        params: req.params,
        query: req.query
    });
    
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal Server Error',
        error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Join rooms for user and valet
    socket.on('joinRoom', (room) => {
        socket.join(room);
        console.log(`Socket ${socket.id} joined room ${room}`);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Background job: every 60 seconds, auto-cancel any pending order older
    // than 30 minutes that hasn't been picked up by a valet. Refunds the
    // customer if they paid. See orderController.autoCancelStaleOrders.
    // Set AUTO_CANCEL_ENABLED=false for the first boot after an outage. Every
    // order left pending while the API was down is by then well past the 30
    // minute threshold, so the first tick would cancel and refund all of them
    // about a minute after start, before anyone could look at the backlog.
    if (process.env.AUTO_CANCEL_ENABLED === 'false') {
        console.warn('Auto-cancel cron DISABLED via AUTO_CANCEL_ENABLED=false — stale orders will accumulate until re-enabled.');
    } else {
        try {
            const { autoCancelStaleOrders } = require('./controllers/orderController');
            setInterval(() => {
                autoCancelStaleOrders(io).catch((e) =>
                    console.error('autoCancelStaleOrders interval error:', e.message)
                );
            }, 60 * 1000);
            console.log('Auto-cancel cron registered (runs every 60s)');
        } catch (err) {
            console.error('Failed to register auto-cancel cron:', err.message);
        }
    }

    // Background job: nightly sweep that hard-deletes parking photos past
    // their 30-day expiry. Covers OrderPhoto rows, ParkingNote sign
    // photos, and StreetParkingMark sign photos. Storage bytes + DB
    // pointers both go. See services/parkingPhotoExpiry.js.
    try {
        require('./services/parkingPhotoExpiry').start();
    } catch (err) {
        console.error('Failed to register photo-expiry cron:', err.message);
    }

    // Background job: ASP sweep — valet reminders 10 min before asp_time and
    // the automatic return order at asp_time. The old EC2 box ran this on an
    // interval; the Render migration lost it, so manual street-cleaning moves
    // stopped auto-returning. See orderController.runAspSweep.
    if (process.env.ASP_SWEEP_ENABLED === 'false') {
        console.warn('ASP sweep DISABLED via ASP_SWEEP_ENABLED=false — ASP orders will not auto-return.');
    } else {
        try {
            const { runAspSweep } = require('./controllers/orderController');
            setInterval(() => {
                runAspSweep(io).catch((e) =>
                    console.error('runAspSweep interval error:', e.message)
                );
            }, 60 * 1000);
            console.log('ASP sweep cron registered (runs every 60s)');
        } catch (err) {
            console.error('Failed to register ASP sweep cron:', err.message);
        }
    }

    // Background job: auto-ASP subscription scheduler — books the covered
    // street-cleaning move for every active subscriber ~45 min before their
    // scheduled sweep. Idempotent via Order.autoBookKey (unique index); never
    // fires for lapsed/past_due/cancelled subscriptions; orders are $0 so
    // there is nothing to double-charge. See services/subscriptionScheduler.js.
    if (process.env.SUBS_SCHEDULER_ENABLED === 'false') {
        console.warn('Subscription scheduler DISABLED via SUBS_SCHEDULER_ENABLED=false — auto-ASP moves will not book.');
    } else {
        try {
            const { tick } = require('./services/subscriptionScheduler');
            setInterval(() => {
                tick({ io }).catch((e) =>
                    console.error('subscriptionScheduler interval error:', e.message)
                );
            }, 60 * 1000);
            console.log('Subscription scheduler registered (runs every 60s)');
        } catch (err) {
            console.error('Failed to register subscription scheduler:', err.message);
        }
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        // Deliberately fatal. Falling back to a random port used to leave the
        // process "up" on a port nothing routes to, so the host reported a
        // healthy service while every request 502'd.
        console.error(
            `Port ${PORT} is already in use — refusing to start on a random port. ` +
            `Kill whatever holds ${PORT} and restart.`
        );
    } else {
        console.error(err);
    }
    process.exit(1);
});
