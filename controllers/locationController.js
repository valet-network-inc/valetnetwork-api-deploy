const mongoose = require('mongoose');
const FreeSpace = require('../models/FreeSpace');

// Display window for free-spot pins. A spot someone saw half an hour ago
// is stale enough to be misleading, so the list simply stops returning
// the pin after this — no client cleanup needed.
const LIST_WINDOW_MINUTES = 30;

exports.markFreeSpace = async (req, res) => {
    const { userId, segmentId, latitude, longitude } = req.body;

    try {
        if (!userId || latitude === undefined || longitude === undefined) {
            return res.status(400).json({
                success: false,
                message: 'userId, latitude, and longitude are required'
            });
        }
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                message: 'userId must be a valid id'
            });
        }

        const freeSpace = new FreeSpace({
            userId,
            // Optional since the pin redesign — old builds still send the
            // legacy ML segment id, new builds may send nothing.
            segmentId: segmentId || '',
            latitude,
            longitude
        });

        await freeSpace.save();

        res.status(201).json({
            success: true,
            message: 'Free space marked successfully',
            data: freeSpace,
            expiresInMinutes: LIST_WINDOW_MINUTES
        });
    } catch (error) {
        console.error('Error marking free space:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark free space',
            error: error.message
        });
    }
};

exports.deleteFreeSpace = async (req, res) => {
    const { freeSpaceId } = req.params;
    // Ownership comes from the caller — same trust model as the other
    // valet routes (no JWT yet), but at least a pin can no longer be
    // deleted anonymously or by a different valet.
    const userId = req.query.userId || req.body?.userId;

    try {
        if (!freeSpaceId || !mongoose.Types.ObjectId.isValid(freeSpaceId)) {
            return res.status(400).json({
                success: false,
                message: 'valid freeSpaceId is required'
            });
        }
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                message: 'userId is required to remove a pin'
            });
        }

        const freeSpace = await FreeSpace.findById(freeSpaceId);

        if (!freeSpace) {
            return res.status(404).json({
                success: false,
                message: 'Free space entry not found'
            });
        }
        if (String(freeSpace.userId) !== String(userId)) {
            return res.status(403).json({
                success: false,
                message: 'Only the valet who marked this spot can remove it'
            });
        }

        await FreeSpace.deleteOne({ _id: freeSpace._id });

        res.status(200).json({
            success: true,
            message: 'Free space entry deleted successfully',
            data: freeSpace
        });
    } catch (error) {
        console.error('Error deleting free space:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete free space entry',
            error: error.message
        });
    }
};

exports.listFreeSpaces = async (req, res) => {
    try {
        const now = new Date();
        const windowStart = new Date(
            now.getTime() - LIST_WINDOW_MINUTES * 60 * 1000
        );

        // No populate: the public pin list used to ship the marking
        // valet's name, phone and photo to any caller. A pin only needs
        // a position, an owner id (so the app can offer "remove" on your
        // own pins) and its age.
        const freeSpaces = await FreeSpace.find({
            createdAt: { $gte: windowStart }
        })
            .sort({ createdAt: -1 })
            .select('userId latitude longitude createdAt')
            .lean();

        res.status(200).json({
            success: true,
            message: 'Free spaces retrieved successfully',
            count: freeSpaces.length,
            windowMinutes: LIST_WINDOW_MINUTES,
            data: freeSpaces
        });
    } catch (error) {
        console.error('Error listing free spaces:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve free spaces',
            error: error.message
        });
    }
};

exports.listFreeSpacesByUser = async (req, res) => {
    const { userId } = req.params;

    try {
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                message: 'valid userId is required'
            });
        }

        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const freeSpaces = await FreeSpace.find({
            userId,
            createdAt: { $gte: twentyFourHoursAgo }
        }).sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            message: 'User free spaces retrieved successfully',
            count: freeSpaces.length,
            data: freeSpaces
        });
    } catch (error) {
        console.error('Error listing user free spaces:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve user free spaces',
            error: error.message
        });
    }
};
