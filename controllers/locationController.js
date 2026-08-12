const FreeSpace = require('../models/FreeSpace');

exports.markFreeSpace = async (req, res) => {
    const { userId, segmentId, latitude, longitude } = req.body;

    try {
        if (!userId || !segmentId || latitude === undefined || longitude === undefined) {
            return res.status(400).json({
                success: false,
                message: 'userId, segmentId, latitude, and longitude are required'
            });
        }

        const freeSpace = new FreeSpace({
            userId,
            segmentId,
            latitude,
            longitude
        });

        await freeSpace.save();

        res.status(201).json({
            success: true,
            message: 'Free space marked successfully',
            data: freeSpace
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

    try {
        if (!freeSpaceId) {
            return res.status(400).json({
                success: false,
                message: 'freeSpaceId is required'
            });
        }

        const freeSpace = await FreeSpace.findByIdAndDelete(freeSpaceId);

        if (!freeSpace) {
            return res.status(404).json({
                success: false,
                message: 'Free space entry not found'
            });
        }

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
        const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);

        const freeSpaces = await FreeSpace.find({
            createdAt: { $gte: fifteenMinutesAgo }
        })
            .sort({ createdAt: -1 })
            .populate('userId', 'firstName lastName phone profileImage');

        res.status(200).json({
            success: true,
            message: 'Free spaces retrieved successfully',
            count: freeSpaces.length,
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
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'userId is required'
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
