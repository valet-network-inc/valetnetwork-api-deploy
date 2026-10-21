const User = require('../models/User');

/** GET /api/admin/app-builds — counts by platform and build, plus who is on each. */
exports.listAppBuilds = async (req, res) => {
    try {
        const users = await User.find({ 'app.seenAt': { $exists: true }, isDeleted: { $ne: true } })
            .select('firstName lastName phone isValet app')
            .sort({ 'app.seenAt': -1 })
            .lean();
        const groups = new Map();
        for (const u of users) {
            const key = `${u.app.platform || 'other'} ${u.app.build || '?'}`;
            const g = groups.get(key) || { platform: u.app.platform || 'other', build: u.app.build || null, count: 0, users: [] };
            g.count += 1;
            g.users.push({
                id: String(u._id),
                name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.phone || null,
                isValet: !!u.isValet,
                seenAt: u.app.seenAt,
            });
            groups.set(key, g);
        }
        const builds = [...groups.values()].sort((a, b) => Number(b.build || 0) - Number(a.build || 0));
        return res.json({ success: true, total: users.length, builds });
    } catch (err) {
        console.error('listAppBuilds error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
