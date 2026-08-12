const mongoose = require('mongoose');

const GuestPaymentSchema = new mongoose.Schema({
    conversationId: {
        type: String,
        required: true,
        unique: true,
    },
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    payment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
    },
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
    },
    amount: {
        type: Number,
        required: true,
    },
    currency: {
        type: String,
        default: 'usd',
    },
    status: {
        type: String,
        enum: ['pending', 'processing', 'succeeded', 'failed'],
        default: 'pending',
    },
    paymentIntentId: {
        type: String,
    },
    paymentLinkId: {
        type: String,
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
    paidAt: {
        type: Date,
    },
    failureReason: {
        type: String,
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('GuestPayment', GuestPaymentSchema);
