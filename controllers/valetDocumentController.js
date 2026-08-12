/**
 * valetDocumentController
 *
 * Handles driver's license uploads from the valet contractor app.
 *
 * Flow:
 *   1. Mobile app uploads DL front (or back) via multipart POST.
 *   2. We validate, push the file to Firebase Storage at a private path,
 *      create a ValetDocument record, mark any prior doc of the same
 *      type as 'superseded'.
 *   3. If the valet now has BOTH dl_front and dl_back stored, AND their
 *      Certn check has passed, we transition them to
 *      `pending_provider_approval` (which surfaces them on the admin
 *      dashboard for Rishi to send to insurance providers).
 *   4. Status transitions are appended to User.statusHistory for audit.
 *
 * The document file itself is private — only the backend (via admin SDK)
 * and authenticated admin endpoints (via signed URLs) can read it.
 */

const path = require('path');
const crypto = require('crypto');

const User = require('../models/User');
const ValetDocument = require('../models/ValetDocument');
const firebaseStorage = require('../services/firebaseStorage');
const valetStatusService = require('../services/valetStatusService');

// Accepted mime types for DL photos. PDFs allowed in case a valet uploads
// a scan rather than a phone photo.
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'];

// Valid document types the upload endpoint accepts.
const VALID_TYPES = ['drivers_license_front', 'drivers_license_back'];

/**
 * Build the storage path for a given upload.
 * Example: valet-documents/<userId>/drivers_license_front/<timestamp>-<random>.jpg
 */
const buildStoragePath = (userId, type, mimeType, originalFilename) => {
    const ext = path.extname(originalFilename || '').toLowerCase()
        || (mimeType === 'application/pdf' ? '.pdf' : '.jpg');
    const random = crypto.randomBytes(8).toString('hex');
    return `valet-documents/${userId}/${type}/${Date.now()}-${random}${ext}`;
};

/**
 * POST /api/valet/uploadDriversLicense
 * Multipart form: { userId, type } + file field "file"
 * Returns: { success, document: { id, type, status, uploadedAt } }
 */
exports.uploadDriversLicense = async (req, res) => {
    try {
        const { userId, type } = req.body;
        const file = req.file;

        // -- Validation
        if (!userId || !type || !file) {
            return res.status(400).json({
                success: false,
                message: 'userId, type, and file are required.',
            });
        }
        if (!VALID_TYPES.includes(type)) {
            return res.status(400).json({
                success: false,
                message: `type must be one of: ${VALID_TYPES.join(', ')}`,
            });
        }
        if (!ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
            return res.status(400).json({
                success: false,
                message: `Unsupported file type. Accepted: JPG, PNG, HEIC, PDF.`,
            });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        if (!user.isValet) {
            return res.status(403).json({
                success: false,
                message: 'Only valet accounts can upload contractor documents.',
            });
        }

        // -- Upload to Firebase Storage
        const storagePath = buildStoragePath(userId, type, file.mimetype, file.originalname);
        const { bucket } = await firebaseStorage.uploadFile(
            file.buffer,
            storagePath,
            file.mimetype
        );

        // -- Mark any previous doc of this type as 'superseded'
        await ValetDocument.updateMany(
            { userId, type, status: 'stored' },
            { $set: { status: 'superseded' } }
        );

        // -- Create the new record
        const doc = await ValetDocument.create({
            userId,
            type,
            status: 'stored',
            s3Bucket: bucket,         // schema field is named s3Bucket for legacy reasons but holds the Firebase bucket name
            s3Key: storagePath,
            mimeType: file.mimetype,
            fileSize: file.size,
            originalFilename: file.originalname,
            uploadedAt: new Date(),
        });

        // -- Maybe advance the valet's status if all prerequisites are now met
        await valetStatusService.maybeAdvanceToProviderApproval(user);

        return res.json({
            success: true,
            document: {
                id: doc._id,
                type: doc.type,
                status: doc.status,
                uploadedAt: doc.uploadedAt,
            },
            valetOnboardingStatus: user.valetOnboardingStatus,
        });
    } catch (err) {
        console.error('uploadDriversLicense error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Upload failed.',
        });
    }
};

/**
 * GET /api/valet/myDocuments?userId=<id>
 * Returns the valet's currently-stored documents (one per type).
 */
exports.getMyDocuments = async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required.' });
        }

        const docs = await ValetDocument.find({
            userId,
            status: 'stored',
        }).select('type uploadedAt mimeType').lean();

        return res.json({
            success: true,
            documents: docs,
        });
    } catch (err) {
        console.error('getMyDocuments error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to load documents.',
        });
    }
};
