const User = require('../models/User');
const FCMToken = require('../models/FCMToken');
const { resolveSignupPlatform } = require('../services/signupPlatform');

// Function to generate a random 6-character code (numbers and capital letters)
const generateReferralCode = () => {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += characters.charAt(
            Math.floor(Math.random() * characters.length)
        );
    }
    return code;
};

// Function to check if referral code already exists
const isReferralCodeUnique = async (code) => {
    const existingUser = await User.findOne({ referralCode: code });
    return !existingUser;
};

// Function to generate a unique referral code
const generateUniqueReferralCode = async () => {
    let code;
    let isUnique = false;

    while (!isUnique) {
        code = generateReferralCode();
        isUnique = await isReferralCodeUnique(code);
    }

    return code;
};

exports.loginUser = async (req, res) => {

    console.log('login request body', req.body);
    const { phone, firebaseUid, fcmToken, deviceId } = req.body;
    const signupPlatform = resolveSignupPlatform(req);

    try {
        // Deleted accounts never get past here, and this read is also what
        // tells us whether the account is brand new.
        const existing = await User.findOne({ phone })
            .select('_id isDeleted firstName enterpriseBusinessName')
            .lean();

        if (existing && existing.isDeleted) {
            return res.status(403).json({
                success: false,
                message: 'This account has been deleted. Please contact support for assistance.',
            });
        }

        // ONE atomic write, deliberately not load-mutate-save.
        //
        // The app posts this on every launch and React Native fires it twice —
        // 108 of 310 calls in one week arrived within half a second of their
        // twin. Both copies used to load the same document at `__v: n`, both
        // called save(), and the second one's version guard matched nothing and
        // threw VersionError, which this handler turned into a 500. AuthContext
        // catches that, never sets the user, and AuthLoadingScreen replaces the
        // stack with LoginScreen — so a signed-in customer gets thrown back to
        // "what's your number?" on launch. It hit 12 accounts, 11 of them real
        // customers, in the last seven days of retained logs alone.
        //
        // findOneAndUpdate carries no version guard, so a concurrent twin is a
        // harmless second write of identical values. It also stops save() from
        // materialising `cleaningSchedule`'s subdocument defaults on every
        // login, which is all those failed writes were ever carrying.
        const user = await upsertLoginUser({ phone, firebaseUid, signupPlatform });

        if (fcmToken) {
            await FCMToken.findOneAndUpdate(
                { token: fcmToken },
                {
                    firebaseUid,
                    token: fcmToken,
                    deviceId: deviceId || 'unknown',
                    isActive: true,
                    lastUsedAt: new Date(),
                },
                { upsert: true, new: true }
            );
        }

        // "Still needs the create-account screen." A user has completed setup if
        // they have a personal first name (customer / valet) OR an enterprise
        // business name (enterprise / doorman) — without the second half,
        // enterprise users, who never fill in firstName, get routed back through
        // CreateAccountScreen on every login and clobber their own data.
        const isNewUser = !(user.firstName || user.enterpriseBusinessName);

        return res.status(200).json({
            isNewUser,
            message: !existing
                ? 'New user created'
                : isNewUser
                    ? 'Returning user needs to setup account'
                    : 'User already existed and is logged in successfully',
            user,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to verify user',
        });
    }
};

/**
 * Upsert the login fields for a phone number, atomically.
 *
 * `phone` is a unique index, so two simultaneous first-logins can race the
 * upsert and one of them comes back E11000 — the other one won, so retry once
 * as a plain update and return the document it created.
 */
async function upsertLoginUser({ phone, firebaseUid, signupPlatform }) {
    const update = {
        $set: { firebaseUid, verified: false, isActive: true },
        // Where they signed up, not where they were last seen: written only
        // when this call is the one that creates the account.
        $setOnInsert: { signupPlatform },
    };

    try {
        return await User.findOneAndUpdate({ phone }, update, {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
        });
    } catch (err) {
        if (err && err.code === 11000) {
            return User.findOneAndUpdate(
                { phone },
                { $set: update.$set },
                { new: true }
            );
        }
        throw err;
    }
}

exports.updateUser = async (req, res) => {
    const {
        phone,
        firstName,
        lastName,
        age,
        isValet,
        isChauffeur,
        chauffeurOnline,
        profileImage,
        isActive,
        isDoorman,
        enterpriseCode,
        enterpriseName,
        userAgreementAccepted,
        enterpriseBusinessName,
        enterpriseAddress, // { street, suite, city, state, zip }
    } = req.body;

    try {
        const updateData = {
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
            ...(age !== undefined && { age }),
            ...(isValet !== undefined && { isValet }),
            ...(isChauffeur !== undefined && { isChauffeur }),
            ...(chauffeurOnline !== undefined && { chauffeurOnline }),
            ...(profileImage && { profileImage }),
            // ...(isActive !== undefined && { isActive }),
            ...(isDoorman !== undefined && { isDoorman }),
            ...(enterpriseCode !== undefined && { enterpriseCode }),
            ...(enterpriseName !== undefined && { enterpriseName }),
            ...(userAgreementAccepted !== undefined && { userAgreementAccepted }),
            ...(enterpriseBusinessName !== undefined && { enterpriseBusinessName }),
            ...(enterpriseAddress !== undefined && { enterpriseAddress }),
        };

        // If user is a doorman and doesn't have a referral code, generate one
        if (isDoorman) {
            const user = await User.findOne({ phone });
            if (!user.referralCode) {
                updateData.referralCode = await generateUniqueReferralCode();
            }
        }

        const user = await User.findOneAndUpdate({ phone }, updateData, {
            new: true,
        });

        res.status(200).json({
            success: true,
            message: 'User updated successfully',
            user,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to update user',
        });
    }
};

exports.getUsers = async (req, res) => {
    const { userIds } = req.query;

    try {
        if (!userIds) {
            return res.status(400).json({
                success: false,
                message: 'userIds parameter is required',
            });
        }

        const userIdArray = userIds.split(',').filter(id => id.trim());
        
        const users = await User.find({
            _id: { $in: userIdArray },
        }).select('firstName lastName profileImage firebaseUid phone email age isValet isDoorman');

        res.status(200).json({
            success: true,
            users,
        });
    } catch (err) {
        console.error('Error in getUsers:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch users',
            error: err.message,
        });
    }
};

exports.getUserById = async (req, res) => {
    const { userId } = req.params;

    try {
        const user = await User.findById(userId);
        res.status(200).json({
            success: true,
            user,
        });
    } catch (err) {
        console.error(err);
    }
};

exports.updateLocation = async (req, res) => {
    const { userId, location } = req.body;

    try {
        const user = await User.findByIdAndUpdate(
            userId,
            {
                currentLocation: {
                    lat: location.lat,
                    lng: location.lng,
                    lastUpdated: new Date(),
                },
            },
            { new: true }
        );

        res.status(200).json({
            success: true,
            message: 'Location updated successfully',
            location: user.currentLocation,
        });
    } catch (error) {
        console.error('Error updating location:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update location',
        });
    }
};

exports.deleteAccount = async (req, res) => {
    const { userId } = req.params;

    try {
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        // Store phone number to ensure deletion by phone as well
        const phoneNumber = user.phone;

        // Delete by ID
        await User.findByIdAndDelete(userId);

        // Also ensure we delete or reset any user with this phone number
        // This is an additional safeguard
        await User.updateOne(
            { phone: phoneNumber },
            {
                $unset: {
                    firstName: '',
                    lastName: '',
                    age: '',
                    isValet: '',
                    profileImage: '',
                },
            }
        );

        res.status(200).json({
            success: true,
            message: 'Account deleted successfully',
        });
    } catch (err) {
        console.error('Error deleting account:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to delete account',
        });
    }
};

exports.checkUserType = async (req, res) => {
    const { phone, firebaseUid } = req.body;

    try {
        if (!phone && !firebaseUid) {
            return res.status(400).json({
                success: false,
                message: 'Either phone or firebaseUid is required',
            });
        }

        let user;
        if (phone) {
            user = await User.findOne({ phone });
        } else if (firebaseUid) {
            user = await User.findOne({ firebaseUid });
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        const userType = user.isValet ? 'valet' : 'customer';

        res.status(200).json({
            success: true,
            userType,
            userId: user._id,
            phone: user.phone,
            firebaseUid: user.firebaseUid,
            isValet: user.isValet,
        });
    } catch (err) {
        console.error('Error checking user type:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to check user type',
        });
    }
};
