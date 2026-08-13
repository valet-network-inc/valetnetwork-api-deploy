const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const FCMToken = require('../models/FCMToken');
const { inferLegacyPlatform } = require('../services/signupPlatform');

// Helper function to format time in hours, minutes and seconds
const formatTime = (minutes) => {
    if (!minutes || minutes === 0) return '0sec';
    
    const totalMinutes = Math.floor(minutes);
    const secs = Math.round((minutes - totalMinutes) * 60);
    
    // If less than 60 minutes, show minutes and seconds
    if (totalMinutes < 60) {
        if (totalMinutes === 0) return `${secs}sec`;
        if (secs === 0) return `${totalMinutes}min`;
        return `${totalMinutes}min ${secs}sec`;
    }
    
    // If 60+ minutes, show hours and minutes
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    
    if (mins === 0) return `${hours}hr`;
    return `${hours}hr ${mins}min`;
};

// ==================== BUSINESS METRICS ====================

exports.getBusinessMetrics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const dateFilter = {};
        
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
            if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
        }

        // Helper function to get revenue for a period
        const getRevenuePeriod = async (days) => {
            const now = new Date();
            const startOfPeriod = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
            
            const grossData = await Order.aggregate([
                { $match: { createdAt: { $gte: startOfPeriod }, paymentStatus: 'paid' } },
                { $group: { _id: null, total: { $sum: '$totalAmount' } } }
            ]);
            
            const netData = await Order.aggregate([
                { $match: { createdAt: { $gte: startOfPeriod }, status: 'completed', paymentStatus: 'paid' } },
                { $group: { _id: null, total: { $sum: '$totalAmount' } } }
            ]);
            
            return {
                gross: (grossData[0]?.total || 0) / 100,
                net: (netData[0]?.total || 0) / 100
            };
        };

        // Get revenue for different periods
        const todayRevenue = await getRevenuePeriod(1);
        const sevenDaysRevenue = await getRevenuePeriod(7);
        const thirtyDaysRevenue = await getRevenuePeriod(30);
        const ninetyDaysRevenue = await getRevenuePeriod(90);

        // Total requests (active orders with payment and valet)
        const totalRequests = await Order.countDocuments({
            ...dateFilter,
            paymentStatus: 'paid',
            valet: { $ne: null }
        });

        // Completed jobs
        const completedJobs = await Order.countDocuments({
            ...dateFilter,
            status: 'completed',
            paymentStatus: 'paid'
        });

        // Completion rate
        const completionRate = totalRequests > 0 ? ((completedJobs / totalRequests) * 100).toFixed(2) : 0;

        // Gross revenue (all payments)
        const grossRevenueData = await Order.aggregate([
            { $match: { ...dateFilter, paymentStatus: 'paid' } },
            { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]);
        const grossRevenue = grossRevenueData[0]?.total || 0;

        // Net revenue (25% of gross revenue)
        const netRevenue = grossRevenue * 0.25;

        // Active users (users who had orders in the date period)
        const activeUsersData = await Order.distinct('customer', {
            ...dateFilter,
            paymentStatus: 'paid'
        });
        const activeUsers = activeUsersData.length;

        // Active valets (valets who had orders in the date period)
        const activeValetsData = await Order.distinct('valet', {
            ...dateFilter,
            paymentStatus: 'paid',
            valet: { $ne: null }
        });
        const activeValets = activeValetsData.length;

        // Average pickup ETA (dispatch to OTP verification time in minutes)
        const pickupETAData = await Order.aggregate([
            { $match: { ...dateFilter, status: { $ne: 'cancelled' }, paymentStatus: 'paid', valet: { $ne: null } } },
            {
                $group: {
                    _id: null,
                    avgETA: {
                        $avg: {
                            $cond: [
                                { $and: [{ $ne: ['$createdAt', null] }, { $ne: ['$otpVerifiedTimes.orderCreation', null] }] },
                                { $divide: [{ $subtract: ['$otpVerifiedTimes.orderCreation', '$createdAt'] }, 60000] },
                                0
                            ]
                        }
                    }
                }
            }
        ]);
        const avgPickupETA = pickupETAData[0]?.avgETA?.toFixed(2) || 0;

        // Average retrieve time (retrieval order creation to key return OTP verification in minutes)
        const retrieveTimeData = await Order.aggregate([
            { $match: { ...dateFilter, status: 'completed', orderType: 'retrieval', paymentStatus: 'paid', valet: { $ne: null } } },
            {
                $group: {
                    _id: null,
                    avgRetrieveTime: {
                        $avg: {
                            $cond: [
                                { $and: [{ $ne: ['$createdAt', null] }, { $ne: ['$otpVerifiedTimes.returnKey', null] }] },
                                { $divide: [{ $subtract: ['$otpVerifiedTimes.returnKey', '$createdAt'] }, 60000] },
                                0
                            ]
                        }
                    }
                }
            }
        ]);
        const avgRetrieveTime = retrieveTimeData[0]?.avgRetrieveTime?.toFixed(2) || 0;

        // Cancellation rate
        const cancelledOrders = await Order.countDocuments({
            ...dateFilter,
            status: 'cancelled'
        });
        const cancellationRate = totalRequests > 0 ? ((cancelledOrders / totalRequests) * 100).toFixed(2) : 0;

        res.status(200).json({
            success: true,
            data: {
                totalRequests,
                completedJobs,
                completionRate: `${completionRate}%`,
                grossRevenue: (grossRevenue / 100).toFixed(2),
                netRevenue: (netRevenue / 100).toFixed(2),
                activeUsers: activeUsers,
                activeValets: activeValets,
                avgPickupETA: formatTime(parseFloat(avgPickupETA)),
                avgRetrieveTime: formatTime(parseFloat(avgRetrieveTime)),
                cancellationRate: `${cancellationRate}%`,
                revenueByPeriod: {
                    today: {
                        gross: todayRevenue.gross.toFixed(2),
                        net: todayRevenue.net.toFixed(2)
                    },
                    sevenDays: {
                        gross: sevenDaysRevenue.gross.toFixed(2),
                        net: sevenDaysRevenue.net.toFixed(2)
                    },
                    thirtyDays: {
                        gross: thirtyDaysRevenue.gross.toFixed(2),
                        net: thirtyDaysRevenue.net.toFixed(2)
                    },
                    ninetyDays: {
                        gross: ninetyDaysRevenue.gross.toFixed(2),
                        net: ninetyDaysRevenue.net.toFixed(2)
                    }
                }
            }
        });
    } catch (err) {
        console.error('Error fetching business metrics:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch business metrics',
            error: err.message
        });
    }
};

// ==================== USER METRICS ====================

exports.getUserMetrics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const dateFilter = {};
        
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
            if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
        }

        // New users
        const newUsers = await User.countDocuments({
            ...dateFilter,
            isValet: { $ne: true }
        });

        // Returning users (users with more than 1 order)
        const returningUsersData = await Order.aggregate([
            { $match: { ...dateFilter, paymentStatus: 'paid', valet: { $ne: null } } },
            { $group: { _id: '$customer', orderCount: { $sum: 1 } } },
            { $match: { orderCount: { $gt: 1 } } },
            { $count: 'count' }
        ]);
        const returningUsers = returningUsersData[0]?.count || 0;

        // Total requests by service type
        const requestsByServiceType = await Order.aggregate([
            { $match: { ...dateFilter, paymentStatus: 'paid', valet: { $ne: null } } },
            { $group: { _id: '$serviceType', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        // Requests by hour of day
        const requestsByHour = await Order.aggregate([
            { $match: { ...dateFilter, paymentStatus: 'paid', valet: { $ne: null } } },
            {
                $group: {
                    _id: { $hour: '$createdAt' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } },
            {
                $project: {
                    hour: '$_id',
                    count: 1,
                    _id: 0
                }
            }
        ]);

        // Requests by day of week
        const requestsByDayOfWeek = await Order.aggregate([
            { $match: { ...dateFilter, paymentStatus: 'paid', valet: { $ne: null } } },
            {
                $group: {
                    _id: { $dayOfWeek: '$createdAt' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } },
            {
                $project: {
                    day: {
                        $arrayElemAt: [
                            ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
                            { $subtract: ['$_id', 1] }
                        ]
                    },
                    count: 1,
                    _id: 0
                }
            }
        ]);

        // Total active users
        const totalActiveUsers = await User.countDocuments({
            isValet: { $ne: true },
            isActive: true
        });

        // Return rate
        const totalUsers = await User.countDocuments({ isValet: { $ne: true } });
        const returnRate = totalUsers > 0 ? ((returningUsers / totalUsers) * 100).toFixed(2) : 0;

        res.status(200).json({
            success: true,
            data: {
                newUsers,
                returningUsers,
                totalActiveUsers,
                returnRate: `${returnRate}%`,
                requestsByServiceType,
                requestsByHour,
                requestsByDayOfWeek
            }
        });
    } catch (err) {
        console.error('Error fetching user metrics:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch user metrics',
            error: err.message
        });
    }
};

// ==================== VALET METRICS ====================

exports.getValetMetrics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const dateFilter = {};
        
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
            if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
        }

        // Fleet average: Jobs completed per valet
        const jobsPerValetData = await Order.aggregate([
            { $match: { ...dateFilter, status: 'completed', paymentStatus: 'paid', valet: { $ne: null } } },
            { $group: { _id: '$valet', jobsCompleted: { $sum: 1 } } }
        ]);
        const avgJobsPerValet = jobsPerValetData.length > 0 
            ? (jobsPerValetData.reduce((sum, v) => sum + v.jobsCompleted, 0) / jobsPerValetData.length).toFixed(2)
            : 0;

        // Fleet average: Acceptance rate (order-based - % of orders that were accepted by someone)
        const totalOrdersRequested = await Order.countDocuments({
            ...dateFilter,
            notifiedValets: { $exists: true, $ne: [] },
            paymentStatus: 'paid'
        });
        const ordersAccepted = await Order.countDocuments({
            ...dateFilter,
            notifiedValets: { $exists: true, $ne: [] },
            paymentStatus: 'paid',
            valet: { $ne: null } // Order was accepted by a valet
        });
        const avgAcceptanceRate = totalOrdersRequested > 0
            ? ((ordersAccepted / totalOrdersRequested) * 100).toFixed(2)
            : 0;

        // Fleet average: Missed request rate (order-based - % of orders that weren't accepted by anyone)
        const ordersMissed = await Order.countDocuments({
            ...dateFilter,
            notifiedValets: { $exists: true, $ne: [] },
            paymentStatus: 'paid',
            valet: null // Order was NOT accepted by any valet
        });
        const avgMissedRate = totalOrdersRequested > 0
            ? ((ordersMissed / totalOrdersRequested) * 100).toFixed(2)
            : 0;

        // Fleet average: Dispatch to accept time (notification sent to acceptance)
        const dispatchAcceptFleetData = await Order.aggregate([
            { $match: { ...dateFilter, notifiedValets: { $exists: true, $ne: [] }, paymentStatus: 'paid', valet: { $ne: null } } },
            { $unwind: '$notifiedValets' },
            { $match: { 'notifiedValets.accepted': true } },
            {
                $group: {
                    _id: null,
                    avgDispatchAccept: {
                        $avg: {
                            $cond: [
                                { $and: [{ $ne: ['$notifiedValets.notifiedAt', null] }, { $ne: ['$notifiedValets.acceptedAt', null] }] },
                                { $divide: [{ $subtract: ['$notifiedValets.acceptedAt', '$notifiedValets.notifiedAt'] }, 60000] },
                                0
                            ]
                        }
                    }
                }
            }
        ]);
        const avgDispatchAccept = dispatchAcceptFleetData[0]?.avgDispatchAccept?.toFixed(2) || 0;

        // Fleet average: ASP moves per hour.
        // `orderType: 'parking'` because a sweep now also has an auto-created
        // return leg carrying `aspMode` — counting both would report two moves
        // for one physical car.
        const aspMovesFleetData = await Order.aggregate([
            { $match: { ...dateFilter, aspMode: true, orderType: 'parking', status: 'completed', paymentStatus: 'paid', valet: { $ne: null } } },
            { $group: { _id: null, totalAspMoves: { $sum: 1 } } }
        ]);
        const avgAspMovesPerHour = aspMovesFleetData[0]?.totalAspMoves 
            ? (aspMovesFleetData[0].totalAspMoves / 8).toFixed(2)
            : 0;

        res.status(200).json({
            success: true,
            data: {
                avgAcceptanceRate: `${avgAcceptanceRate}%`,
                avgMissedRate: `${avgMissedRate}%`,
                avgDispatchAccept: formatTime(parseFloat(avgDispatchAccept)),
                avgAspMovesPerHour: avgAspMovesPerHour,
                avgJobsPerValet: avgJobsPerValet
            }
        });
    } catch (err) {
        console.error('Error fetching valet metrics:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch valet metrics',
            error: err.message
        });
    }
};

// ==================== VALET LIST WITH METRICS ====================

exports.getValetListWithMetrics = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        // Default to a generous page size since the admin view should normally
        // show every valet at once. The dashboard doesn't currently paginate.
        const limit = parseInt(req.query.limit) || 500;
        const skip = (page - 1) * limit;
        const { startDate, endDate } = req.query;

        const dateFilter = {};
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
            if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
        }

        // Get all valets
        const valets = await User.find({ isValet: true })
            .select('_id firstName lastName phone isActive isDeleted shiftStatus currentLocation createdAt valetOnboardingStatus backgroundCheck')
            .skip(skip)
            .limit(limit);

        // Get total count for pagination
        const totalValets = await User.countDocuments({ isValet: true });

        // Enrich valets with metrics
        const valetsWithMetrics = await Promise.all(valets.map(async (valet) => {
            const valetId = valet._id;

            // Jobs completed
            const jobsCompleted = await Order.countDocuments({
                ...dateFilter,
                valet: valetId,
                status: 'completed',
                paymentStatus: 'paid'
            });

            // Acceptance rate (based on notified valets)
            const notificationData = await Order.aggregate([
                { $match: { ...dateFilter, notifiedValets: { $exists: true, $ne: [] }, paymentStatus: 'paid' } },
                { $unwind: '$notifiedValets' },
                { $match: { 'notifiedValets.valet': valetId } },
                {
                    $group: {
                        _id: null,
                        totalNotifications: { $sum: 1 },
                        acceptedCount: { $sum: { $cond: ['$notifiedValets.accepted', 1, 0] } },
                        missedCount: { $sum: { $cond: ['$notifiedValets.accepted', 0, 1] } }
                    }
                }
            ]);
            const totalNotifications = notificationData[0]?.totalNotifications || 0;
            const acceptedCount = notificationData[0]?.acceptedCount || 0;
            const missedRequests = notificationData[0]?.missedCount || 0;
            const acceptanceRate = totalNotifications > 0 ? ((acceptedCount / totalNotifications) * 100).toFixed(2) : 0;

            // Dispatch to accept time (notification sent to acceptance)
            const dispatchAcceptData = await Order.aggregate([
                { $match: { ...dateFilter, notifiedValets: { $exists: true, $ne: [] }, paymentStatus: 'paid' } },
                { $unwind: '$notifiedValets' },
                { $match: { 'notifiedValets.valet': valetId, 'notifiedValets.accepted': true } },
                {
                    $group: {
                        _id: null,
                        avgTime: {
                            $avg: {
                                $cond: [
                                    { $and: [{ $ne: ['$notifiedValets.notifiedAt', null] }, { $ne: ['$notifiedValets.acceptedAt', null] }] },
                                    { $divide: [{ $subtract: ['$notifiedValets.acceptedAt', '$notifiedValets.notifiedAt'] }, 60000] },
                                    0
                                ]
                            }
                        }
                    }
                }
            ]);
            const dispatchAcceptTime = dispatchAcceptData[0]?.avgTime?.toFixed(2) || 0;

            // Pickup distance (stored at acceptance time)
            const pickupDistanceData = await Order.aggregate([
                { $match: { ...dateFilter, valet: valetId, pickupDistance: { $exists: true, $ne: null } } },
                {
                    $group: {
                        _id: null,
                        avgDistance: { $avg: '$pickupDistance' }
                    }
                }
            ]);
            // Convert from meters to miles (1 meter = 0.000621371 miles)
            const avgDistanceMeters = pickupDistanceData[0]?.avgDistance || 0;
            const pickupDistance = (avgDistanceMeters * 0.000621371).toFixed(2);

            // Parking search time (order creation to when valet parked the car)
            const parkingSearchData = await Order.aggregate([
                { $match: { ...dateFilter, valet: valetId, status: 'completed', orderType: 'parking', paymentStatus: 'paid' } },
                {
                    $group: {
                        _id: null,
                        avgTime: {
                            $avg: {
                                $cond: [
                                    { $and: [{ $ne: ['$otpVerifiedTimes.orderCreation', null] }, { $ne: ['$parkedAt', null] }] },
                                    { $divide: [{ $subtract: ['$parkedAt', '$otpVerifiedTimes.orderCreation'] }, 60000] },
                                    0
                                ]
                            }
                        }
                    }
                }
            ]);
            const parkingSearchTime = parkingSearchData[0]?.avgTime?.toFixed(2) || 0;

            // Retrieval time (retrieval order creation to return key OTP verification)
            const retrievalTimeData = await Order.aggregate([
                { $match: { ...dateFilter, valet: valetId, status: 'completed', orderType: 'retrieval', paymentStatus: 'paid' } },
                {
                    $group: {
                        _id: null,
                        avgTime: {
                            $avg: {
                                $cond: [
                                    { $and: [{ $ne: ['$createdAt', null] }, { $ne: ['$otpVerifiedTimes.returnKey', null] }] },
                                    { $divide: [{ $subtract: ['$otpVerifiedTimes.returnKey', '$createdAt'] }, 60000] },
                                    0
                                ]
                            }
                        }
                    }
                }
            ]);
            const retrievalTime = retrievalTimeData[0]?.avgTime?.toFixed(2) || 0;

            // Idle time - Calculate based on 8-hour shift assumption
            // Get worked hours per day, then calculate idle time as (8 hours - worked hours)
            // Only count days where valet completed at least 1 order
            const idleTimeData = await Order.aggregate([
                { $match: { ...dateFilter, valet: valetId, status: 'completed', paymentStatus: 'paid' } },
                {
                    $addFields: {
                        // Calculate job duration from acceptance to completion (parkedAt or returnKey OTP)
                        jobDuration: {
                            $cond: [
                                { $ne: ['$notifiedValets.acceptedAt', null] },
                                {
                                    $divide: [
                                        {
                                            $subtract: [
                                                {
                                                    $cond: [
                                                        { $ne: ['$otpVerifiedTimes.returnKey', null] },
                                                        '$otpVerifiedTimes.returnKey',
                                                        { $ifNull: ['$parkedAt', '$updatedAt'] }
                                                    ]
                                                },
                                                { $arrayElemAt: ['$notifiedValets.acceptedAt', 0] }
                                            ]
                                        },
                                        60000 // Convert to minutes
                                    ]
                                },
                                0
                            ]
                        },
                        // Extract date (day) from createdAt
                        workDate: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
                    }
                },
                {
                    $group: {
                        _id: '$workDate',
                        totalWorkedMinutes: { $sum: '$jobDuration' },
                        jobCount: { $sum: 1 }
                    }
                },
                {
                    // Only include days with at least 1 completed job
                    $match: {
                        jobCount: { $gte: 1 }
                    }
                },
                {
                    $project: {
                        workedHours: { $divide: ['$totalWorkedMinutes', 60] },
                        idleHours: { $subtract: [8, { $divide: ['$totalWorkedMinutes', 60] }] }
                    }
                },
                {
                    $group: {
                        _id: null,
                        avgIdleHours: { $avg: '$idleHours' },
                        totalDays: { $sum: 1 }
                    }
                }
            ]);
            const avgIdleHours = idleTimeData[0]?.avgIdleHours || 0;
            const idleTime = (avgIdleHours * 60).toFixed(2); // Convert hours to minutes

            // ASP moves per hour — parking orders only, so the sweep's
            // auto-created return leg isn't counted as a second move.
            const valetAspMoves = await Order.countDocuments({
                ...dateFilter,
                valet: valetId,
                aspMode: true,
                orderType: 'parking',
                status: 'completed',
                paymentStatus: 'paid'
            });
            const aspMovesPerHour = (valetAspMoves / 8).toFixed(2);

            const fullName =
                `${valet.firstName || ''} ${valet.lastName || ''}`.trim() ||
                '(no name)';
            const missedRate =
                totalNotifications > 0
                    ? ((missedRequests / totalNotifications) * 100).toFixed(2)
                    : 0;
            // "Truly active" requires BOTH the legacy isActive flag AND the
            // v1.2.0 onboarding status to be 'active'. The dashboard should
            // show the AND of these — a valet stuck mid-onboarding shouldn't
            // appear active even if their legacy isActive=true.
            const onboardingStatus = valet.valetOnboardingStatus || 'active';
            const trulyActive =
                !valet.isDeleted &&
                valet.isActive &&
                onboardingStatus === 'active';

            return {
                _id: valet._id,
                firstName: valet.firstName,
                lastName: valet.lastName,
                name: fullName,
                phone: valet.phone || '',
                // isActive now reflects the combined truth — old dashboards
                // built against this field continue to read sensibly.
                isActive: trulyActive,
                // Granular onboarding status, exposed so the dashboard can
                // show the actual stage ("pending_certn", "suspended_admin",
                // etc.) rather than just a binary active/inactive.
                valetOnboardingStatus: onboardingStatus,
                // Background check summary — dashboard surfaces status +
                // provider in a sub-line so Rishi can see "Passed · Yardstik
                // · May 18" without opening a detail modal. Includes
                // certnApplicationId so the dashboard can build a deep
                // link to the Yardstik report.
                backgroundCheck: valet.backgroundCheck
                    ? {
                          status: valet.backgroundCheck.status,
                          provider: valet.backgroundCheck.provider,
                          completedAt: valet.backgroundCheck.completedAt,
                          certnResult: valet.backgroundCheck.certnResult,
                          certnApplicationId:
                              valet.backgroundCheck.certnApplicationId,
                      }
                    : null,
                isDeletedFlag: valet.isDeleted,
                shiftStatus: valet.shiftStatus,
                currentLocation: valet.currentLocation,
                createdAt: valet.createdAt,
                joinedAt: valet.createdAt,
                // Flat per-valet metrics (consumed by the dashboard's per-valet
                // table) — numbers, not formatted strings.
                completed: jobsCompleted,
                acceptRate: parseFloat(acceptanceRate),
                missedRate: parseFloat(missedRate),
                dispatchAccept: parseFloat(dispatchAcceptTime),
                pickupDist: parseFloat(pickupDistance),
                parkSearch: parseFloat(parkingSearchTime),
                retrieval: parseFloat(retrievalTime),
                idleTime: parseFloat(idleTime),
                aspPerHour: parseFloat(aspMovesPerHour),
                metrics: {
                    jobsCompleted,
                    acceptanceRate: `${acceptanceRate}%`,
                    missedRequests,
                    dispatchAcceptTime: formatTime(parseFloat(dispatchAcceptTime)),
                    pickupDistance: `${pickupDistance} mi`,
                    parkingSearchTime: formatTime(parseFloat(parkingSearchTime)),
                    retrievalTime: formatTime(parseFloat(retrievalTime)),
                    idleTime: formatTime(parseFloat(idleTime)),
                    aspMovesPerHour: `${aspMovesPerHour} moves/hr`
                }
            };
        }));

        res.status(200).json({
            success: true,
            data: valetsWithMetrics,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalValets / limit),
                totalValets,
                limit
            }
        });
    } catch (err) {
        console.error('Error fetching valet list with metrics:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch valet list',
            error: err.message
        });
    }
};

// ==================== VALET MANAGEMENT ====================

exports.deactivateValet = async (req, res) => {
    try {
        const { valetId } = req.body;

        if (!valetId) {
            return res.status(400).json({
                success: false,
                message: 'valetId is required'
            });
        }

        const valet = await User.findByIdAndUpdate(
            valetId,
            { isDeleted: true, isActive: false },
            { new: true }
        ).select('_id firstName lastName isActive isDeleted isValet');

        if (!valet) {
            return res.status(404).json({
                success: false,
                message: 'Valet not found'
            });
        }

        // Cancel any active orders for this valet
        await Order.updateMany(
            {
                valet: valetId,
                status: { $in: ['pending', 'accepted', 'in-progress', 'in_progress', 'parked'] }
            },
            { status: 'cancelled' }
        );

        res.status(200).json({
            success: true,
            message: 'Valet deleted successfully',
            valet
        });
    } catch (err) {
        console.error('Error deactivating valet:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to deactivate valet',
            error: err.message
        });
    }
};

exports.reactivateValet = async (req, res) => {
    try {
        const { valetId } = req.body;

        if (!valetId) {
            return res.status(400).json({
                success: false,
                message: 'valetId is required'
            });
        }

        const valet = await User.findByIdAndUpdate(
            valetId,
            { isDeleted: false, isActive: true },
            { new: true }
        ).select('_id firstName lastName isActive isDeleted isValet');

        if (!valet) {
            return res.status(404).json({
                success: false,
                message: 'Valet not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Valet restored successfully',
            valet
        });
    } catch (err) {
        console.error('Error reactivating valet:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to reactivate valet',
            error: err.message
        });
    }
};

// ==================== CUSTOMER LIST ====================

// GET /api/admin/users — list all non-valet users for the dashboard's
// Customers tab. Returns name, phone, signup date + time, the platform they
// signed up on, and a totalRequests count (orders the customer has placed)
// so the dashboard can show per-customer activity.
exports.getCustomerList = async (req, res) => {
    try {
        // User has no createdAt field — signup time is the timestamp embedded in
        // the ObjectId, which is why this list showed blank dates and, because it
        // was also sorting on that missing field, was not actually in date order.
        const customers = await User.find({ isValet: { $ne: true } })
            .select('_id firstName lastName phone isDoorman enterpriseBusinessName createdAt firebaseUid signupPlatform')
            .sort({ _id: -1 })
            .lean();

        // One pass over Orders to bucket counts by customer id.
        const orderCounts = await Order.aggregate([
            { $match: { customer: { $ne: null } } },
            { $group: { _id: '$customer', count: { $sum: 1 } } },
        ]);
        const countByCustomer = {};
        orderCounts.forEach((row) => {
            if (row._id) countByCustomer[row._id.toString()] = row.count;
        });

        // Which firebase uids ever registered a push token — the mobile-app
        // fingerprint used to date accounts that predate `signupPlatform`.
        const uidsWithPushTokens = new Set(
            await FCMToken.distinct('firebaseUid')
        );

        const data = customers.map((c) => {
            const signedUpAt = c._id.getTimestamp();
            const recorded = c.signupPlatform;
            return {
                _id: c._id,
                name: c.isDoorman
                    ? c.enterpriseBusinessName || '(Enterprise)'
                    : `${c.firstName || ''} ${c.lastName || ''}`.trim() || '(no name)',
                phone: c.phone || '',
                type: c.isDoorman ? 'Enterprise' : 'Customer',
                createdAt: c.createdAt || signedUpAt,
                signedUpAt,
                platform: recorded || inferLegacyPlatform(c, signedUpAt, uidsWithPushTokens),
                // 'recorded' — the client told us at signup.
                // 'inferred' — worked out afterwards from push tokens / signup date,
                //              so the dashboard can mark it as a best guess.
                platformSource: recorded ? 'recorded' : 'inferred',
                totalRequests: countByCustomer[c._id.toString()] || 0,
            };
        });

        res.status(200).json({ success: true, data });
    } catch (err) {
        console.error('Error fetching customer list:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch customer list',
            error: err.message,
        });
    }
};

exports.getValetList = async (req, res) => {
    try {
        const valets = await User.find({ isValet: true, isDeleted: { $ne: true } })
            .select('_id firstName lastName isActive shiftStatus currentLocation')
            .sort({ firstName: 1 });

        res.status(200).json({
            success: true,
            data: valets
        });
    } catch (err) {
        console.error('Error fetching valet list:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch valet list',
            error: err.message
        });
    }
};

// ==================== SERVICE REQUEST LOG ====================

/**
 * Every service request ever created, newest first, for the dashboard's
 * "Services" tab.
 *
 * Two joins the UI can't do for itself: the customer's name and phone, and the
 * assigned valet's name. Both are resolved here in two queries rather than one
 * lookup per row.
 *
 * `valetsPaged` is the length of notifiedValets and is the important column.
 * A valet is only paged once payment succeeds — the backend never dispatches on
 * its own, the client does it after the card clears — so an abandoned checkout
 * leaves a real-looking request that nobody was ever told about. Surfacing the
 * count is what makes that visible instead of mysterious.
 */
exports.getServiceList = async (req, res) => {
    try {
        const orders = await Order.find({})
            .select(
                '_id customer valet customerLocation parkingType orderType aspMode ' +
                'status paymentStatus totalAmount isFreeService notifiedValets createdAt checkout'
            )
            .sort({ _id: -1 })
            .lean();

        const userIds = [
            ...new Set(
                orders
                    .flatMap((o) => [o.customer, o.valet])
                    .filter(Boolean)
                    .map(String)
            ),
        ];
        const users = await User.find({ _id: { $in: userIds } })
            .select('_id firstName lastName phone isDoorman enterpriseBusinessName')
            .lean();
        const byId = new Map(users.map((u) => [String(u._id), u]));

        const nameOf = (u) => {
            if (!u) return '';
            if (u.isDoorman) return u.enterpriseBusinessName || '(Enterprise)';
            return `${u.firstName || ''} ${u.lastName || ''}`.trim();
        };

        const serviceOf = (o) => {
            if (o.orderType === 'retrieval') return 'Retrieval';
            if (o.aspMode) return 'Street-cleaning (ASP)';
            if (o.parkingType === 'garage') return 'Garage';
            return 'Street parking';
        };

        const data = orders.map((o) => {
            const cust = byId.get(String(o.customer));
            const valet = o.valet ? byId.get(String(o.valet)) : null;
            return {
                _id: o._id,
                // Order has no reliable createdAt on older rows; the ObjectId
                // timestamp is always correct and always present.
                createdAt: o.createdAt || o._id.getTimestamp(),
                customerName: nameOf(cust) || '(no name)',
                customerPhone: cust ? cust.phone || '' : '(deleted user)',
                service: serviceOf(o),
                amount: (o.totalAmount || 0) / 100,
                isFreeService: !!o.isFreeService,
                status: o.status || 'unknown',
                paymentStatus: o.paymentStatus || 'unknown',
                valetName: nameOf(valet),
                valetsPaged: Array.isArray(o.notifiedValets) ? o.notifiedValets.length : 0,
                // How far this customer got. 'abandoned' means a card form was
                // ready and no card was ever submitted; 'declined' means one was
                // submitted and refused.
                reached: o.paymentStatus === 'paid' || (o.checkout && o.checkout.paidAt)
                    ? 'paid'
                    : o.checkout && o.checkout.failedAt
                        ? 'declined'
                        : o.checkout && o.checkout.intentCreatedAt
                            ? 'abandoned'
                            : 'no card form',
                address: (o.customerLocation && o.customerLocation.streetAddress) || '',
            };
        });

        res.status(200).json({ success: true, data });
    } catch (err) {
        console.error('Error fetching service list:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch service list',
            error: err.message,
        });
    }
};

// ==================== CHECKOUT FUNNEL ====================

/**
 * Where paying customers stop.
 *
 * Built from three server-side stamps (Order.checkout) so it needs no app
 * release. Free/event-code orders are excluded — they never see a card form,
 * so counting them would flatter the numbers.
 *
 * The distinction that matters is the last two buckets:
 *   declined  — a card was submitted and the charge was refused (Stripe told us)
 *   abandoned — a card form was ready and no card was ever submitted
 *
 * Before the webhook was repointed on 2026-08-12 those failure events were
 * being delivered to the previous vendor's host, so "declined" is only reliable
 * from that date forward. Older rows fall back to what the order itself says.
 */
exports.getCheckoutFunnel = async (req, res) => {
    try {
        const orders = await Order.find({ totalAmount: { $gt: 0 }, isFreeService: { $ne: true } })
            .select('_id totalAmount paymentStatus checkout customer')
            .sort({ _id: -1 })
            .lean();

        const buckets = { created: 0, reachedCheckout: 0, paid: 0, declined: 0, abandoned: 0 };
        const declineReasons = {};
        let lostCents = 0;

        orders.forEach((o) => {
            const c = o.checkout || {};
            buckets.created += 1;
            if (c.intentCreatedAt) buckets.reachedCheckout += 1;

            if (o.paymentStatus === 'paid' || c.paidAt) {
                buckets.paid += 1;
                return;
            }
            if (c.failedAt) {
                buckets.declined += 1;
                const key = c.failureCode || 'unknown';
                declineReasons[key] = (declineReasons[key] || 0) + 1;
            } else {
                buckets.abandoned += 1;
            }
            lostCents += o.totalAmount || 0;
        });

        const pct = (n) => (buckets.created ? Number(((n / buckets.created) * 100).toFixed(1)) : 0);

        res.status(200).json({
            success: true,
            data: {
                ...buckets,
                paidRate: pct(buckets.paid),
                abandonRate: pct(buckets.abandoned),
                declineRate: pct(buckets.declined),
                lostRevenue: (lostCents / 100).toFixed(2),
                declineReasons,
                // Stamps only exist for orders created after 2026-08-13. Older rows
                // are classified from paymentStatus alone, so reachedCheckout
                // undercounts history — say so rather than let it read as a drop.
                note: 'checkout timestamps begin 2026-08-13; earlier orders are inferred from paymentStatus',
            },
        });
    } catch (err) {
        console.error('Error building checkout funnel:', err);
        res.status(500).json({ success: false, message: 'Failed to build checkout funnel', error: err.message });
    }
};
