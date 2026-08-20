const express = require('express');
const router = express.Router();
const {
    getSchedule,
    setSchedule,
    pauseSchedule,
    resumeSchedule,
    clearSchedule,
    dismissSuggestion,
    getMonth,
} = require('../controllers/cleaningScheduleController');

// The free street-cleaning alarm. Also the schedule a subscription books
// against, which is why it hangs off the user rather than off a plan.
router.get('/:userId', getSchedule);
router.put('/:userId', setSchedule);
router.delete('/:userId', clearSchedule);
router.get('/:userId/month', getMonth);
router.post('/:userId/pause', pauseSchedule);
router.post('/:userId/resume', resumeSchedule);
router.post('/:userId/suggestion/dismiss', dismissSuggestion);

module.exports = router;
