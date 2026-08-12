const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Payout = require('../models/Payout');
const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY ? stripeModule(process.env.STRIPE_API_KEY) : null;
const { v4: uuidv4 } = require('uuid');

// Subscription pricing in cents
const SUBSCRIPTION_PRICES = {
    Standard: 40000, // $400
    Garage: 10000, // $100
};

// Commission rates (5% of subscription price)
const COMMISSION_RATES = {
    Standard: 2000, // $20 (5% of $400)
    Garage: 500, // $5 (5% of $100)
};

// Create a new subscription
exports.createSubscription = async (req, res) => {
    const { userId, referralCode, paymentMethodId, subscriptionType } =
        req.body;
    try {
        if (!stripe) {
            return res.status(503).json({
                success: false,
                message: 'Stripe API key not configured. Payment service unavailable.',
            });
        }

        // Validate input
        if (!userId || !paymentMethodId || !subscriptionType) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields',
            });
        }

        // Validate subscription type
        if (!['Standard', 'Garage'].includes(subscriptionType)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid subscription type',
            });
        }

        // Find user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        // Prevent self-referral if referralCode is present
        if (
            referralCode &&
            user.referralCode &&
            user.referralCode === referralCode
        ) {
            return res.status(400).json({
                success: false,
                message: 'You cannot refer yourself',
            });
        }

        // Check if user already has an active subscription
        if (user.activeSubscription) {
            const activeSub = await Subscription.findById(
                user.activeSubscription
            );
            if (activeSub && activeSub.active) {
                return res.status(400).json({
                    success: false,
                    message: 'User already has an active subscription',
                });
            }
        }

        let doorman = null;
        let commissionAmount = null;
        // Only look up doorman and set commission if referralCode is provided
        if (referralCode) {
            doorman = await User.findOne({
                referralCode,
                isDoorman: true,
            });
            console.log(referralCode, doorman);
            if (!doorman) {
                return res.status(404).json({
                    success: false,
                    message: 'Invalid or inactive referral code',
                });
            }
            commissionAmount = COMMISSION_RATES[subscriptionType];
        }

        // Create or get Stripe customer
        let stripeCustomer;
        try {
            if (user.stripeCustomerId) {
                try {
                    stripeCustomer = await stripe.customers.retrieve(
                        user.stripeCustomerId
                    );
                } catch (retrieveErr) {
                    // Customer doesn't exist in current Stripe environment (likely switching from test to production)
                    console.log(
                        `Customer ${user.stripeCustomerId} not found, creating new customer:`,
                        retrieveErr.message
                    );
                    stripeCustomer = null;
                }
            }

            // Create new customer if we don't have one or couldn't retrieve existing one
            if (!stripeCustomer) {
                stripeCustomer = await stripe.customers.create({
                    name: `${user.firstName || ''} ${
                        user.lastName || ''
                    }`.trim(),
                    phone: user.phone,
                    metadata: { userId: user._id.toString() },
                });
                user.stripeCustomerId = stripeCustomer.id;
                await user.save();
            }
        } catch (err) {
            return res.status(500).json({
                success: false,
                message: 'Failed to create or retrieve Stripe customer',
                error: err.message,
            });
        }

        // Attach payment method to customer (ignore if already attached)
        try {
            await stripe.paymentMethods.attach(paymentMethodId, {
                customer: stripeCustomer.id,
            });
        } catch (err) {
            console.error('Stripe attach payment method error:', err);
            if (err.code !== 'resource_already_attached') {
                return res.status(500).json({
                    success: false,
                    message: 'Failed to attach payment method',
                    error: err.message,
                    stripeError: err,
                });
            }
        }

        // Set as default payment method
        try {
            await stripe.customers.update(stripeCustomer.id, {
                invoice_settings: { default_payment_method: paymentMethodId },
            });
        } catch (err) {
            return res.status(500).json({
                success: false,
                message: 'Failed to set default payment method',
                error: err.message,
            });
        }

        // Calculate subscription dates
        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1);

        // Get subscription price
        const amount = SUBSCRIPTION_PRICES[subscriptionType];

        // Create subscription
        const subscription = new Subscription({
            user: user._id,
            subscriptionType,
            startDate,
            endDate,
            active: true,
            paymentStatus: 'pending',
            amount,
            nextBillingDate: endDate,
        });
        // Only set doorman, referralCode, commissionAmount if referralCode is present
        if (doorman) subscription.doorman = doorman._id;
        if (referralCode) subscription.referralCode = referralCode;
        if (commissionAmount) subscription.commissionAmount = commissionAmount;
        await subscription.save();

        // Update user's active subscription
        user.activeSubscription = subscription._id;
        if (doorman) user.referredBy = doorman._id;
        await user.save();

        // Add user to doorman's referred users (if not already present)
        if (doorman) {
            if (
                !doorman.referredUsers
                    .map((id) => id.toString())
                    .includes(user._id.toString())
            ) {
                doorman.referredUsers.push(user._id);
                await doorman.save();
            }
        }

        res.status(201).json({
            success: true,
            message: 'Subscription created successfully',
            subscription,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to create subscription',
            error: err.message,
        });
    }
};

// Generate referral code for doorman
exports.generateReferralCode = async (req, res) => {
    const { userId } = req.body;

    try {
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        if (!user.isDoorman) {
            return res.status(400).json({
                success: false,
                message: 'User is not a doorman',
            });
        }

        // Generate a unique referral code if not already present
        if (!user.referralCode) {
            user.referralCode = uuidv4().substring(0, 8).toUpperCase();
            await user.save();
        }

        res.status(200).json({
            success: true,
            referralCode: user.referralCode,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to generate referral code',
            error: err.message,
        });
    }
};

// Get user's subscription status
exports.getSubscriptionStatus = async (req, res) => {
    const { userId } = req.params;

    try {
        const user = await User.findById(userId).populate('activeSubscription');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        const hasActiveSubscription = !!(
            user.activeSubscription && user.activeSubscription.active
        );

        res.status(200).json({
            success: true,
            hasActiveSubscription,
            subscription: user.activeSubscription,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to get subscription status',
            error: err.message,
        });
    }
};

// Process subscription renewal/billing
exports.processSubscriptionBilling = async (req, res) => {
    try {
        // Find subscriptions due for renewal
        const now = new Date();
        const subscriptionsDue = await Subscription.find({
            nextBillingDate: { $lte: now },
            active: true,
            renewalAttempted: false,
        }).populate('user doorman');

        console.log(
            `Found ${subscriptionsDue.length} subscriptions due for renewal`
        );

        const results = {
            processed: 0,
            failed: 0,
            details: [],
        };

        for (const subscription of subscriptionsDue) {
            try {
                // Mark as attempted to prevent retries on same execution
                subscription.renewalAttempted = true;
                await subscription.save();

                // Get user and check stripe customer ID
                const user = subscription.user;

                if (!user.stripeCustomerId) {
                    throw new Error('User does not have a Stripe customer ID');
                }

                // Create payment intent
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: subscription.amount,
                    currency: 'usd',
                    customer: user.stripeCustomerId,
                    payment_method_types: ['card', 'pm_card_visa'],
                    confirm: true,
                    off_session: true,
                });

                // Update subscription based on payment status
                subscription.stripePaymentIntentId = paymentIntent.id;
                subscription.paymentStatus =
                    paymentIntent.status === 'succeeded' ? 'paid' : 'failed';

                if (paymentIntent.status === 'succeeded') {
                    // Calculate new billing period
                    const newStartDate = new Date(subscription.endDate);
                    const newEndDate = new Date(subscription.endDate);
                    newEndDate.setMonth(newEndDate.getMonth() + 1);

                    subscription.startDate = newStartDate;
                    subscription.endDate = newEndDate;
                    subscription.nextBillingDate = newEndDate;
                    subscription.renewalAttempted = false;

                    results.processed++;
                    results.details.push({
                        subscriptionId: subscription._id,
                        status: 'success',
                        paymentIntentId: paymentIntent.id,
                    });

                    // Handle doorman commission if applicable
                    if (subscription.doorman) {
                        // Queue for payout processing
                        await handleDoormanCommission(subscription);
                    }
                } else {
                    // Payment failed
                    subscription.active = false;

                    // Remove active subscription from user
                    await User.findByIdAndUpdate(user._id, {
                        $unset: { activeSubscription: 1 },
                    });

                    results.failed++;
                    results.details.push({
                        subscriptionId: subscription._id,
                        status: 'failed',
                        paymentIntentId: paymentIntent.id,
                    });
                }

                await subscription.save();
            } catch (error) {
                console.error(
                    `Error processing subscription ${subscription._id}:`,
                    error
                );

                // Update subscription as failed
                subscription.paymentStatus = 'failed';
                subscription.active = false;
                await subscription.save();

                // Remove active subscription from user
                await User.findByIdAndUpdate(subscription.user._id, {
                    $unset: { activeSubscription: 1 },
                });

                results.failed++;
                results.details.push({
                    subscriptionId: subscription._id,
                    status: 'failed',
                    error: error.message,
                });
            }
        }

        res.status(200).json({
            success: true,
            message: `Processed ${results.processed} subscriptions, ${results.failed} failed`,
            results,
        });
    } catch (err) {
        console.error('Error in subscription billing process:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to process subscription billing',
            error: err.message,
        });
    }
};

// Handle doorman commissions
async function handleDoormanCommission(subscription) {
    try {
        // Mark that commission is handled for this subscription
        subscription.commissionPaid = true;
        await subscription.save();

        // Find or create a pending payout for this doorman
        let payout = await Payout.findOne({
            doorman: subscription.doorman._id,
            status: 'pending',
        });

        if (!payout) {
            payout = new Payout({
                doorman: subscription.doorman._id,
                amount: 0,
                status: 'pending',
                subscriptions: [],
            });
        }

        // Add subscription commission amount to payout
        payout.amount += subscription.commissionAmount;
        payout.subscriptions.push(subscription._id);

        await payout.save();

        return true;
    } catch (error) {
        console.error('Error handling doorman commission:', error);
        return false;
    }
}

// Process doorman payouts
exports.processDoormanPayouts = async (req, res) => {
    try {
        // Find pending payouts above minimum threshold ($50)
        const pendingPayouts = await Payout.find({
            status: 'pending',
            amount: { $gte: 5000 }, // $50 in cents
        }).populate('doorman subscriptions');

        console.log(`Found ${pendingPayouts.length} payouts to process`);

        const results = {
            processed: 0,
            failed: 0,
            details: [],
        };

        for (const payout of pendingPayouts) {
            try {
                const doorman = payout.doorman;

                // Create a Stripe transfer (assumes doorman has connected account)
                // In a real implementation, you'd need to set up Stripe Connect
                // and store the doorman's connected account ID

                // Simplified example - in real app, use Stripe Connect
                /* 
                const transfer = await stripe.transfers.create({
                    amount: payout.amount,
                    currency: 'usd',
                    destination: doorman.stripeConnectAccountId,
                    transfer_group: `payout_${payout._id}`,
                });
                
                payout.stripeTransferId = transfer.id;
                */

                // For now, just mark as processed
                payout.status = 'processed';
                payout.processedDate = new Date();
                await payout.save();

                results.processed++;
                results.details.push({
                    payoutId: payout._id,
                    doormanId: doorman._id,
                    amount: payout.amount,
                    status: 'success',
                });
            } catch (error) {
                console.error(`Error processing payout ${payout._id}:`, error);

                // Mark as failed
                payout.status = 'failed';
                await payout.save();

                results.failed++;
                results.details.push({
                    payoutId: payout._id,
                    status: 'failed',
                    error: error.message,
                });
            }
        }

        res.status(200).json({
            success: true,
            message: `Processed ${results.processed} payouts, ${results.failed} failed`,
            results,
        });
    } catch (err) {
        console.error('Error in doorman payout process:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to process doorman payouts',
            error: err.message,
        });
    }
};

// Cancel subscription
exports.cancelSubscription = async (req, res) => {
    const { subscriptionId } = req.params;

    try {
        const subscription = await Subscription.findById(subscriptionId);

        if (!subscription) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found',
            });
        }

        // Mark subscription as inactive
        subscription.active = false;
        await subscription.save();

        // Remove active subscription reference from user
        await User.findByIdAndUpdate(subscription.user, {
            $unset: { activeSubscription: 1 },
        });

        res.status(200).json({
            success: true,
            message: 'Subscription cancelled successfully',
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel subscription',
            error: err.message,
        });
    }
};

// Get total number of active subscriptions
exports.getActiveSubscriptionCount = async (req, res) => {
    try {
        const count = await Subscription.countDocuments({ active: true });
        res.status(200).json({ count });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Failed to get subscription count',
            error: err.message,
        });
    }
};

// Get all subscriptions referred by a doorman
exports.getReferredSubscriptions = async (req, res) => {
    const { doormanId } = req.params;
    try {
        const subscriptions = await Subscription.find({ doorman: doormanId })
            .populate('user', 'firstName lastName')
            .sort({ startDate: -1 });
        res.status(200).json({ subscriptions });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to get referred subscriptions',
            error: err.message,
        });
    }
};
