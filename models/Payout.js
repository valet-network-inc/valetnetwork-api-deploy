const mongoose = require('mongoose');

const PayoutSchema = new mongoose.Schema({
    doorman: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
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
    conversationId: {
        type: String,
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
    paymentType: {
        type: String,
        enum: ['guest_checkout', 'subscription', 'order_payment'],
        default: 'order_payment',
    },
    subscriptions: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subscription',
    }],
    stripeTransferId: {
        type: String,
    },
    paidAt: {
        type: Date,
    },
    processedDate: {
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

module.exports = mongoose.model('Payout', PayoutSchema);