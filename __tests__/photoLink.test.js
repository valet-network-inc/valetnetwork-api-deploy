/**
 * The photo link in the chat (orderPhotoController.viewPhotoByLink). The
 * message text has to carry a link the app's link finder picks up whole,
 * and the link has to open a fresh signed URL for as long as the photo
 * exists.
 */
jest.mock('../services/firebaseStorage', () => ({
    getSignedUrl: jest.fn(async (storagePath, minutes) => `https://storage.example/${storagePath}?ttl=${minutes}`),
    uploadFile: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const OrderPhoto = require('../models/OrderPhoto');
const photoLinkRouter = require('../routes/photoLink');
const { photoLink, photoMessageText, newShareToken } = require('../controllers/orderPhotoController');

let mongo;
const app = express();
app.use('/api/photo', photoLinkRouter);

const makePhoto = (extra = {}) =>
    OrderPhoto.create({
        order: new mongoose.Types.ObjectId(),
        valet: new mongoose.Types.ObjectId(),
        type: 'post_park',
        bucket: 'test-bucket',
        storagePath: 'order-photos/x/post_park/1.jpg',
        mimeType: 'image/jpeg',
        shareToken: newShareToken(),
        ...extra,
    });

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});
afterEach(async () => {
    await OrderPhoto.deleteMany({});
});

test('the chat link opens a fresh signed URL', async () => {
    const photo = await makePhoto();
    const res = await request(app).get(`/api/photo/${photo.shareToken}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://storage.example/order-photos/x/post_park/1.jpg?ttl=10');
});

test('an unknown link, a bad link and an expired photo are a 404 page', async () => {
    expect((await request(app).get(`/api/photo/${newShareToken()}`)).status).toBe(404);
    expect((await request(app).get('/api/photo/x')).status).toBe(404);
    const old = await makePhoto({ expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).get(`/api/photo/${old.shareToken}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain('30 days');
});

test('the message text carries the link whole', () => {
    const link = photoLink({ shareToken: 'abcDEF123_-xyz12' });
    expect(link).toBe('https://api.valetnetwork.co/api/photo/abcDEF123_-xyz12');
    const text = photoMessageText('Photo after parking', link);
    expect(text).toBe('Photo after parking: https://api.valetnetwork.co/api/photo/abcDEF123_-xyz12');
    // The app's chat turns URLs into taps by splitting on this pattern.
    expect(text.split(/(https?:\/\/[^\s]+)/g)).toContain(link);
    expect(photoMessageText('Photo after parking', null)).toBe('Photo after parking — tap to view');
});
