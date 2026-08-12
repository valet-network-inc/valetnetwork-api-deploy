/**
 * firebaseStorage
 *
 * Thin wrapper over the Firebase Admin Storage SDK. The default storage
 * bucket is configured in server.js when admin.initializeApp() runs, so
 * here we just grab `admin.storage().bucket()` and expose two helpers:
 *
 *   - uploadFile:   write a Buffer to a destination path in the bucket.
 *   - getSignedUrl: produce a short-lived URL admins can use to view a
 *                   stored document (e.g., DL photo) without making the
 *                   bucket public.
 *
 * All files in this bucket are PRIVATE by default. The Firebase Storage
 * security rules (set up in production mode at bucket creation) deny all
 * direct read access. Backend code reads via the admin SDK; admin
 * dashboard views call our backend, which returns a signed URL.
 */

const admin = require('firebase-admin');

const bucket = () => admin.storage().bucket();

/**
 * Upload a buffer to the bucket.
 *
 * @param {Buffer} buffer        - file contents
 * @param {string} destination   - path inside the bucket, e.g. "valet-documents/<userId>/<type>/<filename>"
 * @param {string} mimeType      - e.g. "image/jpeg" or "application/pdf"
 * @returns {Promise<{bucket: string, path: string}>}
 */
exports.uploadFile = async (buffer, destination, mimeType) => {
    const b = bucket();
    const file = b.file(destination);
    await file.save(buffer, {
        metadata: { contentType: mimeType },
        resumable: false,    // small files; resumable upload is overkill
    });
    return { bucket: b.name, path: destination };
};

/**
 * Generate a short-lived signed URL for reading a stored file. Used by
 * the admin dashboard to display DL photos without exposing the bucket.
 *
 * @param {string} destination          - path inside the bucket
 * @param {number} expiresInMinutes     - default 15 minutes
 * @returns {Promise<string>}
 */
exports.getSignedUrl = async (destination, expiresInMinutes = 15) => {
    const [url] = await bucket().file(destination).getSignedUrl({
        action: 'read',
        expires: Date.now() + expiresInMinutes * 60 * 1000,
    });
    return url;
};

/**
 * Delete a stored file. Used rarely — we typically mark documents as
 * 'superseded' rather than deleting (audit trail). Provided for cases
 * where storage cleanup is genuinely needed (e.g., test data).
 *
 * @param {string} destination
 */
exports.deleteFile = async (destination) => {
    await bucket().file(destination).delete({ ignoreNotFound: true });
};
