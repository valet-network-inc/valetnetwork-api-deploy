const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        doorman: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        subscriptionType: {
            type: String,
            enum: ['Standard', 'Garage'],
            required: true,
        },
        startDate: {
            type: Date,
            required: true,
            default: Date.now,
        },
        endDate: {
            type: Date,
            required: true,
        },
        active: {
            type: Boolean,
            default: true,
        },
        paymentStatus: {
            type: String,
            enum: ['pending', 'paid', 'failed', 'refunded', 'canceled'],
            default: 'pending',
        },
        amount: {
            type: Number,
            required: true,
            default: 50000, // $500 in cents
        },
        referralCode: {
            type: String,
        },
        renewalAttempted: {
            type: Boolean,
            default: false,
        },
        stripePaymentIntentId: {
            type: String,
        },
        commissionPaid: {
            type: Boolean,
            default: false,
        },
        commissionAmount: {
            type: Number,
        },
        nextBillingDate: {
            type: Date,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('Subscription', SubscriptionSchema);
