const express = require('express');
const { createJob, getJob } = require('../controllers/jobController');

const router = express.Router();

router.post('/', createJob);
router.get('/:id', getJob);

module.exports = router;