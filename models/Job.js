const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true
  },
  type: {
    type: String,
    enum: ['ESTIMATE_GAINS'],
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
    default: 'PENDING'
  },
  data: {
    userEmail: String
  },
  result: mongoose.Schema.Types.Mixed,
  error: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date
}, { timestamps: true });

module.exports = mongoose.model('Job', jobSchema);