const Queue = require('bull');
const { connectRedis } = require('../config/redis');
const logger = require('../utils/logger');

let estimationQueue;

// Inicializar cola
const initializeQueue = async () => {
  try {
    await connectRedis();
    
    estimationQueue = new Queue('estimation jobs', {
      redis: {
        host: process.env.REDIS_URL?.split('//')[1]?.split(':')[0] || 'localhost',
        port: process.env.REDIS_URL?.split(':')[2] || 6379
      }
    });
    
    logger.info('Cola de estimación inicializada');
    return estimationQueue;
  } catch (error) {
    logger.error('Error inicializando cola:', error);
    throw error;
  }
};

// Crear job de estimación
const createEstimationJob = async (jobId, data) => {
  try {
    if (!estimationQueue) {
      await initializeQueue();
    }
    
    await estimationQueue.add('estimate', {
      jobId,
      ...data
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });
    
    logger.info(`Job de estimación encolado: ${jobId}`);
  } catch (error) {
    logger.error('Error encolando job:', error);
    throw error;
  }
};

// Obtener cola
const getEstimationQueue = () => {
  return estimationQueue;
};

module.exports = {
  initializeQueue,
  createEstimationJob,
  getEstimationQueue
};