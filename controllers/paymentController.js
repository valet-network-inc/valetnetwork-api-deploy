const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const Payment = require('../models/Payment');
const GuestPayment = require('../models/GuestPayment');
const Order = require('../models/Order');
const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY ? stripeModule(process.env.STRIPE_API_KEY) : null;
const User = require('../models/User');
const axios = require('axios');
const admin = require('firebase-admin');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Helper function to send Slack notification
const sendSlackNotification = async (title, message, details = {}) => {
    try {
        const environment = process.env.STRIPE_API_KEY && process.env.STRIPE_API_KEY.includes('sk_live') ? 'production' : 'development';
        const payload = {
            text: `*[${environment.toUpperCase()}] ${title}*\n${message}`,
            attachments: [
                {
                    color: 'good',
                    fields: [
                        {
                            title: 'Environment',
                            value: environment,
                            short: true,
                        },
                        ...Object.entries(details).map(([key, value]) => ({
                            title: key,
                            value: String(value),
                            short: true,
                        })),
                    ],
                    ts: Math.floor(Date.now() / 1000),
                },
            ],
        };

        if (!SLACK_WEBHOOK_URL) {
            console.warn('SLACK_WEBHOOK_URL not set — skipping Slack alert:', title);
            return;
        }
        await axios.post(SLACK_WEBHOOK_URL, payload, { timeout: 5000 });
        console.log('Slack notification sent:', title);
    } catch (err) {
        console.error('Failed to send Slack notification:', err.message);
    }
};

// Helper function to save message to Firestore
const saveMessageToFirestore = async (conversationId, message) => {
    try {
        if (!conversationId) {
            console.warn('Cannot save message to Firestore: missing conversationId');
            return;
        }

        const db = admin.firestore();
        const messageData = {
            ...message,
            conversationId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            type: 'PAYMENT_STATUS',
        };

        const docRef = await db
            .collection('conversations')
            .doc(conversationId)
            .collection('messages')
            .add(messageData);

        console.log('✅ Message saved to Firestore:', docRef.id);
    } catch (err) {
        console.error('Failed to save message to Firestore:', err.message);
    }
};

// Helper function to send message to conversation (Socket.IO + Firestore)
const sendMessageToConversation = async (io, conversationId, message) => {
    if (!conversationId) {
        console.warn('Cannot send message: missing conversationId');
        return;
    }
    
    console.log('Sending message to conversation:', conversationId, message);
    
    // Save to Firestore
    await saveMessageToFirestore(conversationId, message);
    
    // Emit Socket.IO event if available
    if (io) {
        io.to(conversationId).emit('paymentStatusUpdate', {
            conversationId,
            ...message,
            timestamp: new Date(),
        });
    }
};

exports.createPaymentIntent = async (req, res) => {
    const { orderId, currency = 'usd' } = req.body;

    try {
        if (!stripe) {
            return res.status(503).json({
                success: false,
                message: 'Stripe API key not configured. Payment service unavailable.',
            });
        }

        // Validate required fields
        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: 'orderId is required',
            });
        }

        // Find the order
        const order = await Order.findById(orderId).populate('customer');
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Fetch amount from order's totalAmount
        // const amount = 50;
        const amount = order.totalAmount || 0;

        console.log('Creating payment intent for order:', orderId, 'Amount:', amount);

        // --- Card-on-file support ---
        // 1) Ensure the customer has a Stripe Customer object so saved payment methods persist.
        // 2) Create an ephemeral key the mobile SDK uses to list saved cards in the PaymentSheet.
        // 3) Attach the customer to the PaymentIntent and set setup_future_usage so the card
        //    is saved after a successful charge.
        let stripeCustomerId = order.customer.stripeCustomerId;
        if (!stripeCustomerId) {
            const newStripeCustomer = await stripe.customers.create({
                metadata: {
                    userId: order.customer._id.toString(),
                    phone: order.customer.phone || '',
                },
                name: [order.customer.firstName, order.customer.lastName]
                    .filter(Boolean)
                    .join(' ') || order.customer.establishmentName || undefined,
                phone: order.customer.phone || undefined,
            });
            stripeCustomerId = newStripeCustomer.id;
            await User.findByIdAndUpdate(order.customer._id, {
                stripeCustomerId,
            });
            console.log('Created Stripe customer for user:', order.customer._id, '->', stripeCustomerId);
        }

        // Ephemeral key — required so the mobile Stripe SDK can list saved cards in the PaymentSheet.
        // apiVersion must match a version supported by the installed @stripe/stripe-react-native.
        // Update this if the mobile SDK is upgraded and complains about version mismatch.
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: stripeCustomerId },
            { apiVersion: '2024-06-20' }
        );

        // Create payment intent with Stripe — now attached to the customer and set up to save the card.
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount),
            currency: currency,
            automatic_payment_methods: { enabled: true },
            customer: stripeCustomerId,
            setup_future_usage: 'off_session', // save the card on the customer for later reuse
            metadata: {
                orderId: orderId,
                customerId: order.customer._id.toString(),
                conversationId: order.conversationId || '',
                platform: 'react-native',
            },
        });

        console.log('Created payment intent:', paymentIntent.id);

        // Funnel step 2 of 3. Reaching here means the customer's checkout screen
        // mounted and a card form was ready; the gap between this and paidAt is
        // where customers are being lost. Best-effort — a stamping failure must
        // never cost the customer their payment intent.
        try {
            await Order.findByIdAndUpdate(orderId, {
                $set: { 'checkout.intentCreatedAt': new Date() },
            });
        } catch (stampErr) {
            console.error('Failed to stamp checkout.intentCreatedAt:', stampErr.message);
        }

        // Create Payment record
        const payment = new Payment({
            order: orderId,
            customer: order.customer._id,
            paymentIntentId: paymentIntent.id,
            amount: amount,
            currency: currency,
            clientSecret: paymentIntent.client_secret,
            status: 'pending',
            metadata: {
                createdAt: new Date(),
            },
        });

        await payment.save();
        console.log('Payment record created:', payment._id);

        // Update order with paymentIntentId
        await Order.findByIdAndUpdate(
            orderId,
            {
                paymentIntentId: paymentIntent.id,
            },
            { new: true }
        );

        console.log('Order updated with paymentIntentId');

        res.status(200).json({
            success: true,
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            paymentId: payment._id,
            // New fields — the mobile app's PaymentSheet uses these to show saved cards.
            customerId: stripeCustomerId,
            customerEphemeralKeySecret: ephemeralKey.secret,
        });
    } catch (err) {
        console.error('STRIPE ERROR DETAILS:', {
            type: err.type,
            code: err.code,
            param: err.param,
            message: err.message,
            stack: err.stack,
            raw: err.raw,
        });

        res.status(500).json({
            success: false,
            message: err.message,
            stripeError: {
                type: err.type,
                code: err.code,
                param: err.param,
            },
        });
    }
};

exports.updatePaymentStatus = async (req, res) => {
    const {
        orderId,
        paymentIntentId,
        amount,
        currency = 'usd',
        clientSecret,
        chargeId,
        receiptUrl,
        paymentStatus,
        paymentMethodDetails,
        failureReason,
    } = req.body;

    try {
        // Validate required fields
        if (!orderId || !paymentIntentId || !paymentStatus) {
            return res.status(400).json({
                success: false,
                message: 'orderId, paymentIntentId, and paymentStatus are required',
            });
        }

        // Validate paymentStatus
        if (!['pending', 'paid', 'failed'].includes(paymentStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid paymentStatus. Must be one of: pending, paid, failed',
            });
        }

        // Find the order
        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Verify payment with Stripe if paymentStatus is 'paid'
        if (paymentStatus === 'paid' && stripe) {
            try {
                const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
                
                if (paymentIntent.status !== 'succeeded') {
                    return res.status(400).json({
                        success: false,
                        message: `Payment intent status is ${paymentIntent.status}, not succeeded`,
                        stripeStatus: paymentIntent.status,
                    });
                }

                // Extract payment details from Stripe
                const chargeDetails = paymentIntent.charges.data[0];
                const updateData = {
                    paymentStatus: 'paid',
                    paymentIntentId,
                    paymentDetails: {
                        amount: amount || paymentIntent.amount,
                        currency: currency || paymentIntent.currency,
                        clientSecret: clientSecret || paymentIntent.client_secret,
                        chargeId: chargeId || chargeDetails?.id,
                        receiptUrl: receiptUrl || chargeDetails?.receipt_url,
                        paymentMethodDetails: paymentMethodDetails || {
                            type: chargeDetails?.payment_method_details?.type,
                            last4: chargeDetails?.payment_method_details?.card?.last4,
                            brand: chargeDetails?.payment_method_details?.card?.brand,
                        },
                        paidAt: new Date(),
                    },
                };

                const updatedOrder = await Order.findByIdAndUpdate(orderId, updateData, { new: true });

                // Update Payment record
                await Payment.findOneAndUpdate(
                    { paymentIntentId },
                    {
                        status: 'succeeded',
                        chargeId: chargeDetails?.id,
                        receiptUrl: chargeDetails?.receipt_url,
                        paymentMethodDetails: {
                            type: chargeDetails?.payment_method_details?.type,
                            last4: chargeDetails?.payment_method_details?.card?.last4,
                            brand: chargeDetails?.payment_method_details?.card?.brand,
                        },
                        paidAt: new Date(),
                    }
                );

                // Emit socket event
                // Removed 2026-08-06: this broadcast went to EVERY connected socket,
                // including browsers. The room-targeted emits directly below deliver the
                // same payload to the only two parties that act on it, and the clients
                // ignore updates for orders that are not their own. Keeping it meant
                // handing every listener the full order document.
                req.io.to(updatedOrder.customer.toString()).emit('orderUpdated', updatedOrder);
                if (updatedOrder.valet) {
                    req.io.to(updatedOrder.valet.toString()).emit('orderUpdated', updatedOrder);
                }

                return res.status(200).json({
                    success: true,
                    message: 'Payment status updated successfully',
                    order: updatedOrder,
                });
            } catch (stripeError) {
                console.error('Stripe verification error:', stripeError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to verify payment with Stripe',
                    error: stripeError.message,
                });
            }
        }

        // Handle failed payment
        if (paymentStatus === 'failed') {
            const updateData = {
                paymentStatus: 'failed',
                paymentIntentId,
                paymentDetails: {
                    amount: amount || order.totalAmount,
                    currency: currency || 'usd',
                    clientSecret,
                    failureReason: failureReason || 'Payment declined',
                },
            };

            const updatedOrder = await Order.findByIdAndUpdate(orderId, updateData, { new: true });

            // Update Payment record
            await Payment.findOneAndUpdate(
                { paymentIntentId },
                {
                    status: 'failed',
                    failureReason: failureReason || 'Payment declined',
                }
            );

            // Emit socket event
            // Removed 2026-08-06: this broadcast went to EVERY connected socket,
            // including browsers. The room-targeted emits directly below deliver the
            // same payload to the only two parties that act on it, and the clients
            // ignore updates for orders that are not their own. Keeping it meant
            // handing every listener the full order document.
            req.io.to(updatedOrder.customer.toString()).emit('orderUpdated', updatedOrder);

            return res.status(200).json({
                success: true,
                message: 'Payment failure recorded',
                order: updatedOrder,
            });
        }

        // Handle pending status
        const updateData = {
            paymentStatus: 'pending',
            paymentIntentId,
            paymentDetails: {
                amount: amount || order.totalAmount,
                currency: currency || 'usd',
                clientSecret,
            },
        };

        const updatedOrder = await Order.findByIdAndUpdate(orderId, updateData, { new: true });

        // Update Payment record
        await Payment.findOneAndUpdate(
            { paymentIntentId },
            {
                status: 'processing',
                amount: amount || order.totalAmount,
            }
        );

        res.status(200).json({
            success: true,
            message: 'Payment status updated',
            order: updatedOrder,
        });
    } catch (err) {
        console.error('Error updating payment status:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to update payment status',
            error: err.message,
        });
    }
};

exports.getPaymentStatus = async (req, res) => {
    const { conversationId } = req.query;

    try {
        if (!conversationId) {
            return res.status(400).json({
                success: false,
                message: 'conversationId is required',
            });
        }

        // Fetch guest payment by conversation ID
        let guestPayment = await GuestPayment.findOne({ conversationId })
            .populate('payment order customer');

        if (!guestPayment) {
            return res.status(404).json({
                success: false,
                message: 'Payment not found for this conversation',
            });
        }

        // If we have a payment intent ID, verify with Stripe
        if (guestPayment.paymentIntentId && stripe) {
            try {
                const stripePayment = await stripe.paymentIntents.retrieve(guestPayment.paymentIntentId);
                
                // If payment succeeded and status is not yet updated, update it
                if (stripePayment.status === 'succeeded' && guestPayment.status !== 'succeeded') {
                    console.log('Payment confirmed as succeeded, updating GuestPayment status');
                    
                    // Extract charge details from Stripe
                    const chargeDetails = stripePayment.charges.data[0];
                    
                    guestPayment = await GuestPayment.findOneAndUpdate(
                        { conversationId },
                        {
                            status: 'succeeded',
                            paymentIntentId: stripePayment.id,
                            chargeId: chargeDetails?.id,
                            receiptUrl: chargeDetails?.receipt_url,
                            paymentMethodDetails: {
                                type: chargeDetails?.payment_method_details?.type,
                                last4: chargeDetails?.payment_method_details?.card?.last4,
                                brand: chargeDetails?.payment_method_details?.card?.brand,
                            },
                            paidAt: new Date(),
                        },
                        { new: true }
                    ).populate('payment order customer');
                    
                    console.log('GuestPayment status updated to succeeded');
                }
                
                res.status(200).json({
                    success: true,
                    conversationId: guestPayment.conversationId,
                    status: guestPayment.status,
                    stripeStatus: stripePayment.status,
                    amount: guestPayment.amount,
                    currency: guestPayment.currency,
                    paidAt: guestPayment.paidAt,
                    paymentIntentId: guestPayment.paymentIntentId,
                    paymentLinkId: guestPayment.paymentLinkId,
                    chargeId: guestPayment.chargeId,
                    receiptUrl: guestPayment.receiptUrl,
                    paymentMethodDetails: guestPayment.paymentMethodDetails,
                });
            } catch (stripeError) {
                console.error('Stripe fetch error:', stripeError);
                res.status(200).json({
                    success: true,
                    conversationId: guestPayment.conversationId,
                    status: guestPayment.status,
                    amount: guestPayment.amount,
                    currency: guestPayment.currency,
                    paidAt: guestPayment.paidAt,
                    message: 'Fetched from database (Stripe verification unavailable)',
                });
            }
        } else {
            // Return guest payment data from database
            res.status(200).json({
                success: true,
                conversationId: guestPayment.conversationId,
                status: guestPayment.status,
                amount: guestPayment.amount,
                currency: guestPayment.currency,
                paidAt: guestPayment.paidAt,
                paymentIntentId: guestPayment.paymentIntentId,
                paymentLinkId: guestPayment.paymentLinkId,
                chargeId: guestPayment.chargeId,
                receiptUrl: guestPayment.receiptUrl,
                paymentMethodDetails: guestPayment.paymentMethodDetails,
            });
        }
    } catch (err) {
        console.error('Payment status fetch error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payment status',
            error: err.message,
        });
    }
};

exports.handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    try {
        let event;

        // Try to verify signature if secret is configured
        if (webhookSecret && sig) {
            try {
                // req.body should be a Buffer from bodyParser.raw()
                // If it's an object, convert it to string
                let body = req.body;
                if (typeof body === 'object' && !Buffer.isBuffer(body)) {
                    body = JSON.stringify(body);
                }

                console.log('Webhook body type:', typeof body, 'is Buffer:', Buffer.isBuffer(body));

                event = stripe.webhooks.constructEvent(
                    body,
                    sig,
                    webhookSecret
                );
                console.log('Stripe webhook signature verified');
            } catch (signatureError) {
                console.warn('Signature verification failed:', signatureError.message);
                console.log('Processing webhook without signature verification');
                
                // If signature verification fails, use the body as-is (for testing)
                if (typeof req.body === 'string') {
                    event = JSON.parse(req.body);
                } else {
                    event = req.body;
                }
            }
        } else {
            // No signature verification configured, use body as-is
            if (typeof req.body === 'string') {
                event = JSON.parse(req.body);
            } else {
                event = req.body;
            }
        }

        // Validate event object
        if (!event || !event.type) {
            console.error('Invalid webhook event - missing type:', event);
            return res.status(400).json({
                success: false,
                message: 'Invalid webhook event - missing type',
            });
        }

        console.log('Stripe webhook event received:', event.type);

        // Handle payment_intent.succeeded event
        if (event.type === 'payment_intent.succeeded') {
            if (!event.data || !event.data.object) {
                console.error('Invalid payment_intent.succeeded event - missing data.object');
                return res.status(400).json({
                    success: false,
                    message: 'Invalid event structure - missing data.object',
                });
            }

            const paymentIntent = event.data.object;
            let conversationId = paymentIntent.metadata?.conversationId;
            let orderId = paymentIntent.metadata?.orderId;

            // If metadata not found on payment intent, try to get it from the payment link
            if (!conversationId && !orderId && paymentIntent.payment_link) {
                try {
                    const paymentLink = await stripe.paymentLinks.retrieve(paymentIntent.payment_link);
                    conversationId = paymentLink.metadata?.conversationId;
                    orderId = paymentLink.metadata?.orderId;
                    console.log('Retrieved metadata from payment link:', { conversationId, orderId });
                } catch (err) {
                    console.error('Failed to retrieve payment link metadata:', err.message);
                }
            }

            console.log('Payment intent details:', {
                paymentIntentId: paymentIntent.id,
                metadata: paymentIntent.metadata,
                conversationIdFromMetadata: conversationId,
                orderIdFromMetadata: orderId,
            });

            // If orderId is not in metadata, try to find it by searching Payment records
            if (!orderId) {
                console.log('No orderId in metadata, searching for Payment record by paymentIntentId');
                const payment = await Payment.findOne({ paymentIntentId: paymentIntent.id });
                if (payment) {
                    orderId = payment.order.toString();
                    console.log('✅ Found orderId from Payment record:', orderId);
                } else {
                    console.warn('Could not find Payment record for paymentIntentId:', paymentIntent.id);
                }
            }

            // If conversationId is not in metadata, try to find it by searching GuestPayment records
            if (!conversationId) {
                console.log('No conversationId in metadata, searching for GuestPayment');
                
                // Strategy 1: Search by paymentIntentId (if it was already stored)
                let guestPayment = await GuestPayment.findOne({ 
                    paymentIntentId: paymentIntent.id 
                });
                console.log('Search by paymentIntentId result:', guestPayment ? 'Found' : 'Not found');
                
                // Strategy 2: Search for pending GuestPayment with empty paymentIntentId (most recent)
                if (!guestPayment) {
                    console.log('Searching for pending GuestPayment with empty paymentIntentId');
                    guestPayment = await GuestPayment.findOne({
                        paymentIntentId: { $in: ['', null] },
                        status: 'pending'
                    }).sort({ createdAt: -1 });
                    console.log('Search by pending status result:', guestPayment ? 'Found' : 'Not found');
                }
                
                // Strategy 3: Search by amount (for guest payments, amount is always 2000 cents = $20)
                if (!guestPayment && paymentIntent.amount === 2000) {
                    console.log('Searching for pending GuestPayment by amount (2000 cents)');
                    guestPayment = await GuestPayment.findOne({
                        amount: 2000,
                        paymentIntentId: { $in: ['', null] },
                        status: 'pending'
                    }).sort({ createdAt: -1 });
                    console.log('Search by amount result:', guestPayment ? 'Found' : 'Not found');
                }
                
                if (guestPayment) {
                    conversationId = guestPayment.conversationId;
                    console.log('✅ Found conversationId from GuestPayment:', conversationId);
                } else {
                    console.warn('❌ Could not find GuestPayment record for payment intent:', paymentIntent.id);
                    console.warn('Payment intent details:', {
                        id: paymentIntent.id,
                        amount: paymentIntent.amount,
                        metadata: paymentIntent.metadata,
                    });
                }
            }

            console.log('Payment succeeded - conversationId:', conversationId, 'orderId:', orderId);

            // Send Slack notification
            await sendSlackNotification(
                '✅ Payment Succeeded',
                'A payment has been successfully processed.',
                {
                    'Payment Intent ID': paymentIntent.id,
                    'Amount': `$${(paymentIntent.amount / 100).toFixed(2)} ${paymentIntent.currency.toUpperCase()}`,
                    'Conversation ID': conversationId || 'N/A',
                    'Order ID': orderId || 'N/A',
                    'Status': paymentIntent.status,
                }
            );

            const chargeDetails = paymentIntent.charges?.data?.[0];
            const paymentDetails = {
                status: 'succeeded',
                paymentIntentId: paymentIntent.id,
                chargeId: chargeDetails?.id,
                receiptUrl: chargeDetails?.receipt_url,
                paymentMethodDetails: {
                    type: chargeDetails?.payment_method_details?.type,
                    last4: chargeDetails?.payment_method_details?.card?.last4,
                    brand: chargeDetails?.payment_method_details?.card?.brand,
                },
                paidAt: new Date(),
            };

            // Handle guest payment (by conversationId)
            if (conversationId) {
                const updatedGuestPayment = await GuestPayment.findOneAndUpdate(
                    { conversationId },
                    {
                        ...paymentDetails,
                        paymentIntentId: paymentIntent.id, // Store payment intent ID for future lookups
                    },
                    { new: true }
                );
                console.log('GuestPayment updated via webhook:', updatedGuestPayment?._id);
                
                // Update conversation payment status in Firestore
                try {
                    await admin.firestore()
                        .collection('conversations')
                        .doc(conversationId)
                        .update({
                            paymentStatus: 'paid',
                        });
                    console.log('Conversation payment status updated to paid:', conversationId);
                } catch (firestoreError) {
                    console.error('Failed to update conversation payment status:', firestoreError);
                }

                // Send payment success message to conversation
                if (req.io) {
                    sendMessageToConversation(req.io, conversationId, {
                        text: `Payment successful! Your booking is confirmed. Amount: $${(paymentIntent.amount / 100).toFixed(2)} ${paymentIntent.currency.toUpperCase()}`,
                        messageType: 'payment_success',
                        isSystemMessage: true,
                        senderId: 'system',
                        createdAt: new Date(),
                    });
                } else {
                    console.warn('Socket.IO not available, skipping message to conversation');
                }
            } else if (!orderId) {
                // No conversationId and no orderId - this is a guest payment that we couldn't match
                console.warn('Could not find conversationId or orderId for payment intent:', paymentIntent.id);
                console.warn('Payment details:', {
                    amount: paymentIntent.amount,
                    currency: paymentIntent.currency,
                    status: paymentIntent.status,
                });
            }

            // Handle normal order payment (by orderId)
            if (orderId) {
                const updatedOrder = await Order.findByIdAndUpdate(
                    orderId,
                    {
                        paymentStatus: 'paid',
                        // Funnel step 3 of 3 — the customer actually paid.
                        'checkout.paidAt': new Date(),
                        paymentIntentId: paymentIntent.id,
                        paymentDetails: {
                            amount: paymentIntent.amount,
                            currency: paymentIntent.currency,
                            chargeId: chargeDetails?.id,
                            receiptUrl: chargeDetails?.receipt_url,
                            paymentMethodDetails: {
                                type: chargeDetails?.payment_method_details?.type,
                                last4: chargeDetails?.payment_method_details?.card?.last4,
                                brand: chargeDetails?.payment_method_details?.card?.brand,
                            },
                            paidAt: new Date(),
                        },
                    },
                    { new: true }
                ).populate('customer');

                // Update Payment record
                await Payment.findOneAndUpdate(
                    { paymentIntentId: paymentIntent.id },
                    {
                        status: 'succeeded',
                        chargeId: chargeDetails?.id,
                        receiptUrl: chargeDetails?.receipt_url,
                        paymentMethodDetails: {
                            type: chargeDetails?.payment_method_details?.type,
                            last4: chargeDetails?.payment_method_details?.card?.last4,
                            brand: chargeDetails?.payment_method_details?.card?.brand,
                        },
                        paidAt: new Date(),
                    }
                );

                console.log('Order updated via webhook:', updatedOrder?._id);
                
                // Send message to order's conversation if it exists
                if (updatedOrder?.conversationId) {
                    sendMessageToConversation(req.io, updatedOrder.conversationId, {
                        status: 'succeeded',
                        type: 'PAYMENT_SUCCESS',
                        text: 'Payment successful! Your order is confirmed.',
                        senderId: 'system',
                        createdAt: new Date(),
                        amount: paymentIntent.amount / 100,
                        currency: paymentIntent.currency.toUpperCase(),
                        orderId: orderId,
                    });
                }
            }
        }

        // Handle payment_intent.payment_failed event
        if (event.type === 'payment_intent.payment_failed') {
            if (!event.data || !event.data.object) {
                console.error('Invalid payment_intent.payment_failed event - missing data.object');
                return res.status(400).json({
                    success: false,
                    message: 'Invalid event structure - missing data.object',
                });
            }

            const paymentIntent = event.data.object;
            let conversationId = paymentIntent.metadata?.conversationId;
            let orderId = paymentIntent.metadata?.orderId;

            // If metadata not found on payment intent, try to get it from the payment link
            if (!conversationId && !orderId && paymentIntent.payment_link) {
                try {
                    const paymentLink = await stripe.paymentLinks.retrieve(paymentIntent.payment_link);
                    conversationId = paymentLink.metadata?.conversationId;
                    orderId = paymentLink.metadata?.orderId;
                    console.log('Retrieved metadata from payment link:', { conversationId, orderId });
                } catch (err) {
                    console.error('Failed to retrieve payment link metadata:', err.message);
                }
            }

            // If still no conversationId, try to find it by payment link ID
            if (!conversationId && paymentIntent.payment_link) {
                console.log('No conversationId in metadata, searching for GuestPayment by paymentLinkId');
                const guestPayment = await GuestPayment.findOne({ 
                    paymentLinkId: paymentIntent.payment_link 
                });
                
                if (guestPayment) {
                    conversationId = guestPayment.conversationId;
                    console.log('✅ Found conversationId from GuestPayment:', conversationId);
                } else {
                    console.warn('❌ Could not find GuestPayment record for payment link:', paymentIntent.payment_link);
                }
            }

            // If still no conversationId, try to find it using order_reference (checkout session ID)
            if (!conversationId && paymentIntent.payment_details?.order_reference) {
                console.log('No conversationId found, trying to retrieve from checkout session:', paymentIntent.payment_details.order_reference);
                try {
                    const session = await stripe.checkout.sessions.retrieve(paymentIntent.payment_details.order_reference);
                    if (session && session.payment_link) {
                        console.log('Retrieved payment link from session:', session.payment_link);
                        const guestPayment = await GuestPayment.findOne({ 
                            paymentLinkId: session.payment_link 
                        });
                        
                        if (guestPayment) {
                            conversationId = guestPayment.conversationId;
                            console.log('✅ Found conversationId from checkout session:', conversationId);
                        }
                    }
                } catch (err) {
                    console.error('Failed to retrieve checkout session:', err.message);
                }
            }

            console.log('Payment failed - conversationId:', conversationId, 'orderId:', orderId);

            const failureReason = paymentIntent.last_payment_error?.message || 'Payment failed';

            // Funnel: a card WAS submitted and the charge was refused. This is the
            // signal that distinguishes "declined" from "walked away" — Stripe
            // records nothing at all when no card is ever entered, so an order
            // with intentCreatedAt and neither paidAt nor failedAt means the
            // customer left without trying. Best-effort; never block the webhook.
            if (orderId) {
                try {
                    await Order.findByIdAndUpdate(orderId, {
                        $set: {
                            'checkout.failedAt': new Date(),
                            'checkout.failureCode': paymentIntent.last_payment_error?.code || 'unknown',
                            'checkout.failureMessage': failureReason,
                        },
                    });
                } catch (stampErr) {
                    console.error('Failed to stamp checkout.failedAt:', stampErr.message);
                }
            }

            // Send Slack notification
            await sendSlackNotification(
                '❌ Payment Failed',
                'A payment attempt has failed.',
                {
                    'Payment Intent ID': paymentIntent.id,
                    'Amount': `$${(paymentIntent.amount / 100).toFixed(2)} ${paymentIntent.currency.toUpperCase()}`,
                    'Conversation ID': conversationId || 'N/A',
                    'Order ID': orderId || 'N/A',
                    'Failure Reason': failureReason,
                    'Status': paymentIntent.status,
                }
            );

            // Handle guest payment (by conversationId)
            if (conversationId) {
                console.log('Processing guest payment failure for conversationId:', conversationId);
                
                const updatedGuestPayment = await GuestPayment.findOneAndUpdate(
                    { conversationId },
                    {
                        status: 'failed',
                        failureReason: failureReason,
                    },
                    { new: true }
                );
                console.log('GuestPayment marked as failed via webhook:', updatedGuestPayment?._id);
                
                // Update conversation payment status in Firestore
                try {
                    await admin.firestore()
                        .collection('conversations')
                        .doc(conversationId)
                        .update({
                            paymentStatus: 'failed',
                        });
                    console.log('✅ Conversation payment status updated to failed:', conversationId);
                } catch (firestoreError) {
                    console.error('❌ Failed to update conversation payment status:', firestoreError);
                }
                
                // Send message to conversation
                try {
                    await sendMessageToConversation(req.io, conversationId, {
                        status: 'failed',
                        type: 'PAYMENT_FAILED',
                        text: 'Payment failed. Please try again.',
                        senderId: 'system',
                        createdAt: new Date(),
                        failureReason: failureReason,
                    });
                    console.log('✅ Payment failure message sent to conversation:', conversationId);
                } catch (messageError) {
                    console.error('❌ Failed to send payment failure message:', messageError);
                }
            } else {
                console.warn('⚠️ No conversationId found for payment failure - unable to update conversation', {
                    paymentIntentId: paymentIntent.id,
                    paymentLink: paymentIntent.payment_link,
                    amount: paymentIntent.amount,
                });
            }

            // Handle normal order payment (by orderId)
            if (orderId) {
                const updatedOrder = await Order.findByIdAndUpdate(
                    orderId,
                    {
                        paymentStatus: 'failed',
                        paymentIntentId: paymentIntent.id,
                        paymentDetails: {
                            failureReason: failureReason,
                        },
                    },
                    { new: true }
                ).populate('customer');

                // Update Payment record
                await Payment.findOneAndUpdate(
                    { paymentIntentId: paymentIntent.id },
                    {
                        status: 'failed',
                        failureReason: failureReason,
                    }
                );

                console.log('Order marked as failed via webhook:', updatedOrder?._id);
                
                // Send message to order's conversation if it exists
                if (updatedOrder?.conversationId) {
                    await sendMessageToConversation(req.io, updatedOrder.conversationId, {
                        status: 'failed',
                        type: 'PAYMENT_FAILED',
                        text: 'Payment failed. Please try again.',
                        senderId: 'system',
                        createdAt: new Date(),
                        failureReason: failureReason,
                        orderId: orderId,
                    });
                }
            }
        }

        res.status(200).json({
            success: true,
            message: 'Webhook processed successfully',
        });
    } catch (err) {
        console.error('Webhook error:', err.message);
        res.status(400).json({
            success: false,
            message: 'Webhook processing failed',
            error: err.message,
        });
    }
};

exports.createGuestPaymentLink = async (req, res) => {
    const { phone, conversationId, currency = 'usd' } = req.body;

    try {
        if (!stripe) {
            return res.status(503).json({
                success: false,
                message: 'Stripe API key not configured. Payment service unavailable.',
            });
        }

        // Validate required fields
        if (!phone || !conversationId) {
            return res.status(400).json({
                success: false,
                message: 'phone and conversationId are required',
            });
        }

        // Static $20 for guest orders
        const amount = 2000;

        console.log('Creating guest payment link for:', {
            phone,
            conversationId,
            amount,
        });

        // Create a Stripe payment link
        const paymentLink = await stripe.paymentLinks.create({
            line_items: [
                {
                    price_data: {
                        currency: currency,
                        product_data: {
                            name: 'Valet Parking Service',
                            description: `Parking service - Conversation ${conversationId}`,
                        },
                        unit_amount: Math.round(amount),
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                phone: phone,
                conversationId: conversationId,
                guestCheckout: 'true',
            },
            customer_creation: 'if_required',
            billing_address_collection: 'auto',
            after_completion: {
                type: 'redirect',
                redirect: {
                    url: `${process.env.PAYMENT_SUCCESS_URL || 'https://valetnetwork.co/payment-success'}?conversationId=${conversationId}`,
                },
            },
        });

        console.log('Payment link created:', paymentLink.id);

        // Replace existing guest payment with new payment link for this conversation
        const guestPayment = await GuestPayment.findOneAndUpdate(
            { conversationId },
            {
                amount: amount,
                currency: currency,
                status: 'pending',
                paymentLinkId: paymentLink.id,
                paymentLinkUrl: paymentLink.url,
                paymentIntentId: '', // Reset for new payment link
                metadata: {
                    phone: phone,
                    createdFrom: 'createGuestPaymentLink API',
                    timestamp: new Date(),
                },
            },
            { upsert: true, new: true }
        );

        console.log('Guest payment record updated/created:', guestPayment._id);

        // Send payment URL to conversation
        await sendMessageToConversation(req.io, conversationId, {
            text: `Please complete your payment of $${(amount / 100).toFixed(2)}.\n${paymentLink.url}`,
            messageType: 'payment_link',
            link: paymentLink.url,
            containsLink: true,
            isSystemMessage: true,
            senderId: 'system',
            createdAt: new Date(),
        });

        res.status(200).json({
            success: true,
            message: 'Payment link created successfully',
            paymentUrl: paymentLink.url,
            paymentLinkId: paymentLink.id,
            guestPaymentId: guestPayment._id,
            phone: phone,
            conversationId: conversationId,
            amount: amount,
        });
    } catch (err) {
        console.error('Payment link creation error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to create payment link',
            error: err.message,
        });
    }
};
