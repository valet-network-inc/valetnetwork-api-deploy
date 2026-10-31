/**
 * One-off, Oct 30 2026: make the photo messages already in chats openable.
 *
 * They read "Photo after parking — tap to view" with the URL in a field no
 * client reads (see orderPhotoController). For each photo that still exists
 * and has a chat message, this mints a share token if missing and rewrites
 * the message's text and link to the durable /api/photo/<token> link.
 *
 * Dry run by default; --apply writes Mongo + Firestore. Needs MONGO_URI and
 * FIREBASE_SERVICE_ACCOUNT_JSON.
 */
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const OrderPhoto = require('../models/OrderPhoto');
const Order = require('../models/Order');
const { newShareToken, photoLink, photoMessageText, TYPE_LABELS } = require('../controllers/orderPhotoController');

(async () => {
    const apply = process.argv.includes('--apply');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    await mongoose.connect(process.env.MONGO_URI);
    const photos = await OrderPhoto.find({
        chatMessageId: { $exists: true, $nin: [null, ''] },
        expiresAt: { $gt: new Date() },
    }).lean();
    const orders = await Order.find({ _id: { $in: photos.map((p) => p.order) } }).select('_id conversationId').lean();
    const convo = new Map(orders.map((o) => [String(o._id), o.conversationId]));
    let done = 0;
    let skipped = 0;
    for (const p of photos) {
        const conversationId = convo.get(String(p.order));
        if (!conversationId) { skipped++; continue; }
        const ref = admin.firestore().collection('conversations').doc(conversationId).collection('messages').doc(p.chatMessageId);
        const snap = await ref.get();
        if (!snap.exists) { skipped++; continue; }
        const token = p.shareToken || newShareToken();
        const link = photoLink({ shareToken: token });
        if (apply) {
            if (!p.shareToken) {
                await OrderPhoto.updateOne({ _id: p._id, shareToken: { $exists: false } }, { $set: { shareToken: token } });
            }
            await ref.update({ text: photoMessageText(TYPE_LABELS[p.type] || 'Photo', link), link, photoId: String(p._id) });
        }
        done++;
    }
    console.log(JSON.stringify({ livePhotosWithAMessage: photos.length, [apply ? 'rewritten' : 'wouldRewrite']: done, skipped }));
    await mongoose.disconnect();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
