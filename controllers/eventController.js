const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const Event = require('../models/Event');

// Validate event code
exports.validateEventCode = async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Event code is required'
            });
        }

        // Find the event by code (case-insensitive)
        const event = await Event.findOne({ 
            code: code.toUpperCase().trim() 
        });

        if (!event) {
            return res.status(404).json({
                success: false,
                message: 'Invalid event code'
            });
        }

        // Check if event is valid (active, within date range, and has remaining uses)
        if (!event.isValid()) {
            let message = 'Event code is no longer valid';
            
            const now = new Date();
            if (now < event.validFrom) {
                message = 'Event has not started yet';
            } else if (now > event.validUntil) {
                message = 'Event has expired';
            } else if (event.maxUses !== null && event.currentUses >= event.maxUses) {
                message = 'Event code has reached maximum usage limit';
            } else if (!event.isActive) {
                message = 'Event code is inactive';
            }

            return res.status(400).json({
                success: false,
                message
            });
        }

        // Return event details without sensitive information
        res.status(200).json({
            success: true,
            event: {
                code: event.code,
                name: event.name,
                type: event.type,
                serviceType: event.serviceType,
                validUntil: event.validUntil,
                remainingUses: event.maxUses ? event.maxUses - event.currentUses : 'unlimited'
            }
        });

    } catch (error) {
        console.error('Error validating event code:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while validating event code'
        });
    }
};

// Increment event usage when order is created
exports.incrementEventUsage = async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Event code is required'
            });
        }

        const event = await Event.findOne({ 
            code: code.toUpperCase().trim() 
        });

        if (!event) {
            return res.status(404).json({
                success: false,
                message: 'Event not found'
            });
        }

        // Double-check validity before incrementing
        if (!event.isValid()) {
            return res.status(400).json({
                success: false,
                message: 'Event is no longer valid for use'
            });
        }

        // Increment usage
        await event.incrementUsage();

        res.status(200).json({
            success: true,
            message: 'Event usage incremented successfully',
            currentUses: event.currentUses,
            remainingUses: event.maxUses ? event.maxUses - event.currentUses : 'unlimited'
        });

    } catch (error) {
        console.error('Error incrementing event usage:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating event usage'
        });
    }
};

// Get event details by code
exports.getEventDetails = async (req, res) => {
    try {
        const { code } = req.params;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Event code is required'
            });
        }

        const event = await Event.findOne({ 
            code: code.toUpperCase().trim() 
        });

        if (!event) {
            return res.status(404).json({
                success: false,
                message: 'Event not found'
            });
        }

        // Return full event details
        res.status(200).json({
            success: true,
            event: {
                code: event.code,
                name: event.name,
                type: event.type,
                serviceType: event.serviceType,
                validFrom: event.validFrom,
                validUntil: event.validUntil,
                maxUses: event.maxUses,
                currentUses: event.currentUses,
                remainingUses: event.maxUses ? event.maxUses - event.currentUses : 'unlimited',
                isActive: event.isActive,
                isValid: event.isValid(),
                createdAt: event.createdAt
            }
        });

    } catch (error) {
        console.error('Error getting event details:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching event details'
        });
    }
};