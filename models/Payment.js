const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        required: true,
    },
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    paymentIntentId: {
        type: String,
        required: true,
        unique: true,
    },
    amount: {
        type: Number,
        required: true,
    },
    currency: {
        type: String,
        default: 'usd',
    },
    clientSecret: {
        type: String,
    },
    status: {
        type: String,
        enum: ['pending', 'processing', 'succeeded', 'failed', 'canceled'],
        default: 'pending',
    },
    paymentMethod: {
        type: String,
        enum: ['card', 'apple_pay', 'google_pay'],
    },
    chargeId: {
        type: String,
    },
    receiptUrl: {
        type: String,
    },
    paymentMethodDetails: {
        type: {
            type: String,
        },
        last4: {
            type: String,
        },
        brand: {
            type: String,
        },
    },
    failureReason: {
        type: String,
    },
    failureCode: {
        type: String,
    },
    paidAt: {
        type: Date,
    },
    requestedAt: {
        type: Date,
        default: Date.now,
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('Payment', PaymentSchema);
