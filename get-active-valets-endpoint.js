// Add to authController.js or create new controller

exports.getActiveValets = async (req, res) => {
    try {
        const activeValets = await User.find({
            isValet: true,
            isActive: true,
        }).select('firstName lastName phone currentLocation firebaseUid');

        res.status(200).json({
            success: true,
            message: 'Active valets fetched successfully',
            valets: activeValets,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch active valets',
        });
    }
};

// Add to auth.js routes
router.get('/get-active-valets', getActiveValets);
